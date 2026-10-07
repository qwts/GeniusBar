@echo off
REM geniusbar-cli-tool: GeniusBar's agent-bot for the souls it runs (ADR-0046 decision 5): the bundled component on the bundled Node, so a soul needs nothing installed.
"%~dp0..\node.exe" "%~dp0..\components\agent-bot\agent-bot.mjs" %*
