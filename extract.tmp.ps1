$log = Get-Content $env:TEMP\mac-fail.log
$idx = ($log | Select-String -Pattern 'not ok 6 ').LineNumber
if (-not $idx) { $idx = ($log | Select-String -Pattern 'not ok').LineNumber | Select-Object -First 1 }
$log[($idx-1)..($idx+40)] -join "`n"
