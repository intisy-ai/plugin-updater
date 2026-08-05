// Importing src/index.js runs the self-activation IIFE at module load, which is a
// full updater sequence (git pulls, npm updates, deploys, activity emits) against
// whatever home the process points at. In a test run that home is the developer's
// real one, so library mode is forced here for every suite rather than relied on
// per file, where one missing line silently touches the real installation.
process.env.PLUGIN_UPDATER_LIBRARY_MODE = "1";
