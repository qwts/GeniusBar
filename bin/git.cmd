@echo off
REM geniusbar-cli-tool: GeniusBar's git for the souls it runs (ADR-0046 decision 6): the bundled MinGit, so a Windows PC needs no git install.
"%~dp0..\git\cmd\git.exe" %*
