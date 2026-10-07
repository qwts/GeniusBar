@echo off
REM geniusbar-cli-tool: GeniusBar's agent-comms for the souls it runs (ADR-0046 decision 5): the bundled component on the bundled Node, so a soul needs nothing installed.
"%~dp0..\node.exe" "%~dp0..\components\agent-comms\bin\agent-comms.mjs" %*
