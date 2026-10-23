@echo off
rem  ui/data translation data changes -> interactive commit / push
rem  Equivalent to: node scripts/data-commit.js
rem  No args = interactive mode (prompts are printed by the node script).
rem  Args are passed through, e.g.: data-commit.bat --dry-run
rem  NOTE: keep this file pure ASCII - cmd.exe parses .bat with the OEM
rem  codepage, non-ASCII bytes break line parsing. All Chinese output
rem  comes from data-commit.js; chcp 65001 below makes it display right.
chcp 65001 >nul
node "%~dp0data-commit.js" %*
if errorlevel 1 (
  echo.
  echo [data-commit] FAILED - see the messages above.
)
echo.
pause
