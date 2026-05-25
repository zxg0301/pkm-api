# Memory 系统冒烟测试（Windows PowerShell）
# 用法: .\scripts\test-memory.ps1
# 可选: $env:API_BASE = "http://localhost:3001"

$ErrorActionPreference = "Stop"
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

Write-Host "=== Memory 冒烟测试 ===" -ForegroundColor Cyan
Write-Host "API: $Base`n"

try {
    Invoke-RestMethod -Method GET -Uri "$Base/memory/namespaces?user_id=0" | Out-Null
} catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404) {
        Write-Host "[SKIP] Memory API 未启用 (404)。请在 .env 设置 MEMORY_API_ENABLED=true 并执行 init-memory.sql" -ForegroundColor Yellow
        exit 0
    }
    throw
}

# 1. 摄入文档（unified memory + memory tree）
$key = "test-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$ingest = Invoke-MemoryApi -Method POST -Path "/memory/documents/ingest" -Body @{
    user_id = $UserId
    namespace = "test"
    key = $key
    title = "Memory 测试文档"
    content = @"
这是第一段：我们在周一讨论了 Memory Tree 的桶密封与 L0 缓冲区策略。

这是第二段：周二完成了 PostgreSQL 表 mem_tree_chunks 与 mem_tree_summaries 的设计。

这是第三段：周三验证 query_namespace 全文检索与图谱加权是否返回相关内容。
"@
}
$docId = $ingest.document_id
Write-Host "[OK] ingest document_id=$docId chunks=$($ingest.chunk_count) tree admitted=$($ingest.tree.admitted)" -ForegroundColor Green

# 2. 列表与命名空间
$docs = Invoke-MemoryApi -Method GET -Path "/memory/documents?user_id=$UserId&namespace=test"
if ($docs.count -lt 1) { throw "list documents: expected count >= 1" }
Write-Host "[OK] list documents count=$($docs.count)" -ForegroundColor Green

# 3. 语义/关键词检索（unified memory）
$query = Invoke-MemoryApi -Method POST -Path "/memory/query" -Body @{
    user_id = $UserId
    namespace = "test"
    query = "PostgreSQL 密封"
    max_chunks = 5
}
if (-not $query.llm_context_message) { throw "query: empty llm_context_message" }
Write-Host "[OK] memory query returned context ($($query.llm_context_message.Length) chars)" -ForegroundColor Green

# 4. Memory Tree 统计
$stats = Invoke-MemoryApi -Method GET -Path "/memory/tree/stats?user_id=$UserId"
if ([int]$stats.stats.chunks -lt 1) { throw "tree stats: chunks should be >= 1" }
Write-Host "[OK] tree stats chunks=$($stats.stats.chunks) sources=$($stats.stats.sources) summaries=$($stats.stats.summaries)" -ForegroundColor Green

# 5. 强制密封（小文档达不到 5 万 token 阈值，需 flush）
$flush = Invoke-MemoryApi -Method POST -Path "/memory/tree/flush" -Body @{ user_id = $UserId }
Write-Host "[OK] tree flush flushed_buffers=$($flush.flushed_buffers)" -ForegroundColor Green

$sourceId = "doc:test:$docId"
$srcQuery = Invoke-MemoryApi -Method POST -Path "/memory/tree/query/source" -Body @{
    user_id = $UserId
    source_id = $sourceId
    query = "密封"
    limit = 5
}
Write-Host "[OK] tree query/source hits=$($srcQuery.total)" -ForegroundColor Green

# 6. KV + Graph
Invoke-MemoryApi -Method PUT -Path "/memory/kv" -Body @{
    user_id = $UserId
    namespace = "test"
    key = "preference"
    value = @{ theme = "dark" }
} | Out-Null
$kv = Invoke-MemoryApi -Method GET -Path "/memory/kv?user_id=$UserId&namespace=test&key=preference"
if ($kv.value.theme -ne "dark") { throw "kv get failed" }
Write-Host "[OK] kv roundtrip" -ForegroundColor Green

Invoke-MemoryApi -Method POST -Path "/memory/graph" -Body @{
    user_id = $UserId
    namespace = "test"
    subject = "Memory Tree"
    predicate = "uses"
    object = "PostgreSQL"
} | Out-Null
$graph = Invoke-MemoryApi -Method GET -Path "/memory/graph?user_id=$UserId&namespace=test&subject=Memory%20Tree"
if ($graph.count -lt 1) { throw "graph query failed" }
Write-Host "[OK] graph upsert/query count=$($graph.count)" -ForegroundColor Green

# 7. 摘要器预览（不依赖 DB）
$preview = Invoke-MemoryApi -Method POST -Path "/memory/tree/summarize/preview" -Body @{
    items = @(
        @{ id = "a"; content = "周一讨论密封策略。" },
        @{ id = "b"; content = "周二完成数据库设计。" }
    )
}
if (-not $preview.content) { throw "summarize preview: empty content" }
Write-Host "[OK] summarizer=$($preview.summarizer) preview tokens=$($preview.token_count)" -ForegroundColor Green

Write-Host "`n=== 全部通过 ===" -ForegroundColor Cyan
Write-Host "document_id=$docId source_id=$sourceId"
