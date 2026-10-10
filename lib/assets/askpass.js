'use strict';
// devbox VM Manager - SSH_ASKPASS helper (lib/ssh.js askpassEnv starts it
// through a small wrapper; nothing else does). ssh runs it instead of asking
// on a console: it prints the password the manager put into a one-time file
// (DEVBOX_ASKPASS_FILE) and deletes the file at once, so a second prompt - a
// wrong password - gets nothing and ssh gives up instead of looping.
const fs = require('fs');

const file = process.env.DEVBOX_ASKPASS_FILE;
let password = null;
try { password = file ? fs.readFileSync(file, 'utf8') : null; } catch (e) { password = null; }
if (file) { try { fs.rmSync(file, { force: true }); } catch (e) { /* already gone */ } }
if (password === null) process.exit(1);
process.stdout.write(password + '\n');
