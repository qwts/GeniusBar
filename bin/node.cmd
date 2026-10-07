@echo off
REM geniusbar-cli-tool: GeniusBar's Node for the souls it runs (ADR-0046 decision 5): harnesses start their CLI with `node` from PATH, and a stock PC has none.
"%~dp0..\node.exe" %*
