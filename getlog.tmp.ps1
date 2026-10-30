$runId = '41144700482'
$jobs = gh api "repos/dvaJi/cheerox/actions/runs/$runId/jobs?per_page=30" | ConvertFrom-Json
$job = $jobs.jobs | Where-Object { $_.name -like 'native (macos-15,*' }
Write-Output "job: $($job.id)"
gh api "repos/dvaJi/cheerox/actions/jobs/$($job.id)/logs" --allow-escape-sequences > $env:TEMP\mac-fail.log
Select-String -Path $env:TEMP\mac-fail.log -Pattern 'not ok |AssertionError|Error \[' | Select-Object -First 8 | ForEach-Object { $_.Line.Trim().Substring(0, [Math]::Min(150, $_.Line.Trim().Length)) }
