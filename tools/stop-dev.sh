#!/usr/bin/env bash
# kills node/workerd processes pointing into this poc, plus the test stubs
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.CommandLine -match 'flowaccount\.mailpit' -or \$_.CommandLine -match 'stub\.mjs') -and \$_.Name -match '^(node|workerd)\.exe\$' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"
rm -f "$(dirname "$0")"/work/dev-*.pid
