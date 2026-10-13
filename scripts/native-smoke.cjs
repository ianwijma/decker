const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const load = process.argv[2] ? createRequire(resolve(process.argv[2])) : require
const sharp = load('sharp')
const hid = load('node-hid')
assert.ok(process.versions.electron, 'Run this check under Electron')
assert.ok(Array.isArray(hid.devices()))
sharp({create:{width:96,height:96,channels:3,background:'#5865f2'}}).raw().toBuffer().then(buffer=>{
  assert.equal(buffer.length,96*96*3)
  console.log(`Native HID and sharp loaded in Electron ${process.versions.electron}`)
}).catch(error=>{console.error(error);process.exitCode=1})
