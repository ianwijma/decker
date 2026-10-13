// node-hid and sharp ship Node-API prebuilds, which are ABI-stable across Node and Electron.
// CI additionally loads both inside the packaged Electron utility process.
require("node-hid").devices();
require("sharp")({
  create: { width: 1, height: 1, channels: 3, background: "black" },
})
  .png()
  .toBuffer()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
