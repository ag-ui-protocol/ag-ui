# Package

version       = "0.1.0"
author        = "jasagiri"
description   = "Nim SDK for the AG-UI (Agent-User Interaction) protocol 1.0"
license       = "MIT"
srcDir        = "src"

# Dependencies

requires "nim >= 2.2.0"

# Tasks

import std/[algorithm, os, strutils]

task test, "Compile and run every tests/test_*.nim; a compiler warning fails the run":
  var files: seq[string]
  for file in listFiles("tests"):
    let name = file.extractFilename
    if name.startsWith("test_") and name.endsWith(".nim"):
      files.add file
  files.sort()
  for file in files:
    echo "== ", file
    let (output, code) = gorgeEx("nim c --hints:off -r " & file)
    echo output
    if code != 0:
      quit("FAILED: " & file, 1)
    if "Warning:" in output:
      quit("compiler warning in " & file, 1)
  echo "all ", files.len, " test files passed"
