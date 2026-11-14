switch("path", thisDir() & "/../src")
# Compiled test binaries go to the nimcache, not next to the sources.
switch("outdir", nimcacheDir())
