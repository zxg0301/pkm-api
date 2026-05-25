# Memory smoke test (PowerShell, UTF-8)
# Usage: .\scripts\test-memory.ps1
# Optional: $env:API_BASE = "http://localhost:3001"

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Base = if ($env:API_BASE) { $env:API_BASE } else { "http://localhost:3001" }
$UserId = 0

function Invoke-MemoryApi {
    param([string]$Method, [string]$Path, [object]$Body = $null)
    $uri = "$Base$Path"
    $params = @{ Method = $Method; Uri = $uri; ContentType = "application/json; charset=utf-8" }
    if ($Body -ne $null) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }
    try {
        return Invoke-RestMethod @params
    } catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $detail = $reader.ReadToEnd()
            throw "HTTP $([int]$resp.StatusCode) $Path : $detail"
        }
        throw $_
    }
}

Write-Host "=== Memory smoke test ===" -ForegroundColor Cyan
Write-Host "API: $Base`n"

try {
    Invoke-RestMethod -Method GET -Uri "$Base/memory/namespaces?user_id=0" | Out-Null
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404) {
        Write-Host "[SKIP] Memory API disabled (404). Set MEMORY_API_ENABLED=true and run init-memory.sql" -ForegroundColor Yellow
        exit 0
    }
    throw
}

$key = "test-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$ingest = Invoke-MemoryApi -Method POST -Path "/memory/documents/ingest" -Body @{
    user_id = $UserId
    namespace = "test"
    key = $key
    title = "Memory test doc"
    content = @"
Paragraph one: Memory Tree bucket seal and L0 buffer strategy.

Paragraph two: PostgreSQL mem_tree_chunks and mem_tree_summaries design.

Paragraph three: query_namespace FTS and graph weighting.
"@
}
$docId = $ingest.document_id
if ([int]$ingest.tree.seals -lt 1) { throw "ingest: expected tree.seals >= 1" }
Write-Host "[OK] ingest document_id=$docId chunks=$($ingest.chunk_count) tree_seals=$($ingest.tree.seals)" -ForegroundColor Green

$docs = Invoke-MemoryApi -Method GET -Path "/memory/documents?user_id=$UserId&namespace=test" $null
if ($docs.count -lt 1) { throw "list documents: expected count >= 1" }
Write-Host "[OK] list documents count=$($docs.count)" -ForegroundColor Green

$query = Invoke-MemoryApi -Method POST -Path "/memory/query" -Body @{
    user_id = $UserId
    namespace = "test"
    query = "PostgreSQL seal"
    max_chunks = 5
}
if (-not $query.llm_context_message) { throw "query: empty llm_context_message" }
Write-Host "[OK] memory query ($($query.llm_context_message.Length) chars)" -ForegroundColor Green

$stats = Invoke-MemoryApi -Method GET -Path "/memory/tree/stats?user_id=$UserId" $null
if ([int]$stats.stats.chunks -lt 1) { throw "tree stats: chunks should be >= 1" }
Write-Host "[OK] tree stats chunks=$($stats.stats.chunks) summaries=$($stats.stats.summaries)" -ForegroundColor Green

$sourceId = "doc:test:$docId"
# ingest 已密封时 flush/tree 可能为 0（幂等）
$force = Invoke-MemoryApi -Method POST -Path "/memory/tree/flush/tree" -Body @{
    user_id = $UserId
    kind = "source"
    scope = $sourceId
}
Write-Host "[OK] flush/tree seals=$($force.seals) (idempotent if already sealed)" -ForegroundColor Green

$stats2 = Invoke-MemoryApi -Method GET -Path "/memory/tree/stats?user_id=$UserId" $null
if ([int]$stats2.stats.summaries -lt 1) { throw "expected summaries >= 1" }
Write-Host "[OK] summaries=$($stats2.stats.summaries)" -ForegroundColor Green

$srcQuery = Invoke-MemoryApi -Method POST -Path "/memory/tree/query/source" -Body @{
    user_id = $UserId
    source_id = $sourceId
    query = "seal"
    limit = 5
}
if ([int]$srcQuery.total -lt 1) { throw "tree query/source: expected hits >= 1" }
Write-Host "[OK] tree query/source hits=$($srcQuery.total)" -ForegroundColor Green

Invoke-MemoryApi -Method PUT -Path "/memory/kv" -Body @{
    user_id = $UserId
    namespace = "test"
    key = "preference"
    value = @{ theme = "dark" }
} | Out-Null
$kv = Invoke-MemoryApi -Method GET -Path "/memory/kv?user_id=$UserId&namespace=test&key=preference" $null
if ($kv.value.theme -ne "dark") { throw "kv get failed" }
Write-Host "[OK] kv roundtrip" -ForegroundColor Green

Invoke-MemoryApi -Method POST -Path "/memory/graph" -Body @{
    user_id = $UserId
    namespace = "test"
    subject = "Memory Tree"
    predicate = "uses"
    object = "PostgreSQL"
} | Out-Null
$graph = Invoke-MemoryApi -Method GET -Path "/memory/graph?user_id=$UserId&namespace=test&subject=Memory%20Tree" $null
if ($graph.count -lt 1) { throw "graph query failed" }
Write-Host "[OK] graph count=$($graph.count)" -ForegroundColor Green

$preview = Invoke-MemoryApi -Method POST -Path "/memory/tree/summarize/preview" -Body @{
    items = @(
        @{ id = "a"; content = "Monday: seal strategy." },
        @{ id = "b"; content = "Tuesday: database design." }
    )
}
if (-not $preview.content) { throw "summarize preview: empty content" }
Write-Host "[OK] summarizer=$($preview.summarizer) tokens=$($preview.token_count)" -ForegroundColor Green

Write-Host "`n=== All passed ===" -ForegroundColor Cyan
Write-Host "document_id=$docId source_id=$sourceId"
