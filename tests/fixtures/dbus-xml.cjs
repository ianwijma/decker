// Test-only message transport. Never opens a socket or discovers a session bus.
// Inject the application's require so Electron tests exercise app.asar dependencies.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");

const busName = "org.freedesktop.DBus";
const busPath = "/org/freedesktop/DBus";
const player = "org.mpris.MediaPlayer2.alpha";
const secondPlayer = "org.mpris.MediaPlayer2.beta";
const playerPath = "/org/mpris/MediaPlayer2";
const playerInterface = "org.mpris.MediaPlayer2.Player";
const propertiesInterface = "org.freedesktop.DBus.Properties";
const busXml = `<node name="${busPath}">
  <interface name="${busName}">
    <method name="ListNames"><arg name="names" type="as" direction="out"/></method>
    <signal name="NameOwnerChanged"><arg type="s"/><arg type="s"/><arg type="s"/></signal>
  </interface>
</node>`;
const playerXml = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node name="${playerPath}">
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <annotation name="org.example.Description" value="Music &amp; video &lt;fixture&gt; &quot;player&quot;"/>
  </interface>
  <interface name="${playerInterface}">
    <method name="PlayPause"/><method name="Play"/><method name="Pause"/>
    <method name="Stop"/><method name="Next"/><method name="Previous"/>
    <method name="Seek"><arg name="Offset" type="x" direction="in"/></method>
    <method name="SetPosition"><arg name="TrackId" type="o" direction="in"/><arg name="Position" type="x" direction="in"/></method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Volume" type="d" access="readwrite"/>
    <signal name="Seeked"><arg name="Position" type="x"/></signal>
  </interface>
  <interface name="${propertiesInterface}">
    <method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
    <method name="GetAll"><arg type="s" direction="in"/><arg type="a{sv}" direction="out"/></method>
    <method name="Set"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/></method>
    <signal name="PropertiesChanged"><arg type="s"/><arg type="a{sv}"/><arg type="as"/></signal>
  </interface>
  <node name="TrackList"><node name="Tracks"/></node><node name="Playlists"/>
</node>`;

function libraries(appRequire) {
  const dbusRequire = createRequire(appRequire.resolve("dbus-next"));
  return {
    dbus: appRequire("dbus-next"),
    MessageBus: dbusRequire("./lib/bus"),
    xml2js: dbusRequire("xml2js"),
    parserPath: dbusRequire.resolve("xml2js"),
    parserVersion: dbusRequire("xml2js/package.json").version,
  };
}

function createFixture(appRequire, options = {}) {
  const { dbus, MessageBus } = libraries(appRequire);
  const calls = [];
  const errors = [];
  let disconnected = 0;
  const connection = Object.assign(new EventEmitter(), {
    stream: {
      writable: true,
      end() {
        this.writable = false;
        disconnected++;
      },
    },
    message(message) {
      calls.push(message);
      // Reply on a later microtask, as a real connection would. MessageBus.call,
      // reply dispatch, ProxyObject parsing and generated methods are all real.
      queueMicrotask(() => {
        let signature = "";
        let body = [];
        switch (message.member) {
          case "Hello":
            signature = "s";
            body = [":1.100"];
            break;
          case "Introspect":
            signature = "s";
            body = [
              options.xml ??
                (message.destination === busName ? busXml : playerXml),
            ];
            break;
          case "GetNameOwner":
            signature = "s";
            body = [":1.200"];
            break;
          case "ListNames":
            signature = "as";
            body = [[secondPlayer, busName, player]];
            break;
          case "Get":
            signature = "v";
            body = [new dbus.Variant("s", "Paused")];
            break;
          case "GetAll":
            signature = "a{sv}";
            body = [
              {
                PlaybackStatus: new dbus.Variant("s", "Paused"),
                Metadata: new dbus.Variant("a{sv}", {
                  "xesam:title": new dbus.Variant("s", "Music & video"),
                }),
              },
            ];
            break;
        }
        const reply =
          options.refuse === message.member
            ? dbus.Message.newError(
                message,
                "org.mpris.MediaPlayer2.Player.Error.NotSupported",
                "capability unavailable",
              )
            : dbus.Message.newMethodReturn(message, signature, body);
        reply.sender = message.destination === busName ? busName : ":1.200";
        connection.emit("message", reply);
      });
    },
  });
  const bus = new MessageBus(connection);
  bus.on("error", (error) => errors.push(error));
  return {
    bus,
    connection,
    calls,
    errors,
    get disconnected() {
      return disconnected;
    },
  };
}

async function verifyProxy(appRequire) {
  const { dbus } = libraries(appRequire);
  const f = createFixture(appRequire);
  try {
    const daemon = await f.bus.getProxyObject(busName, busPath);
    assert.deepEqual(await daemon.getInterface(busName).ListNames(), [
      secondPlayer,
      busName,
      player,
    ]);
    const object = await f.bus.getProxyObject(player, playerPath);
    assert.deepEqual(object.nodes, [
      `${playerPath}/TrackList`,
      `${playerPath}/Playlists`,
    ]);
    const iface = object.getInterface(playerInterface);
    assert.deepEqual(iface.$properties, [
      { name: "PlaybackStatus", type: "s", access: "read" },
      { name: "Metadata", type: "a{sv}", access: "read" },
      { name: "Volume", type: "d", access: "readwrite" },
    ]);
    for (const operation of [
      "PlayPause",
      "Play",
      "Pause",
      "Stop",
      "Next",
      "Previous",
    ]) {
      assert.equal(await iface[operation](), null);
      assert.equal(f.calls.at(-1).signature, "");
      assert.deepEqual(f.calls.at(-1).body, []);
      assert.equal(f.calls.at(-1).destination, player);
      assert.equal(f.calls.at(-1).interface, playerInterface);
      assert.equal(f.calls.at(-1).path, playerPath);
    }
    await iface.SetPosition("/track/1", 123n);
    assert.equal(f.calls.at(-1).signature, "ox");
    assert.deepEqual(f.calls.at(-1).body, ["/track/1", 123n]);
    await iface.Seek(-100n);
    assert.equal(f.calls.at(-1).signature, "x");
    const props = object.getInterface(propertiesInterface);
    const status = await props.Get(playerInterface, "PlaybackStatus");
    assert(status instanceof dbus.Variant);
    assert.equal(status.signature, "s");
    assert.equal(status.value, "Paused");
    assert.equal(f.calls.at(-1).signature, "ss");
    const all = await props.GetAll(playerInterface);
    assert.equal(all.Metadata.value["xesam:title"].value, "Music & video");
    await props.Set(playerInterface, "Volume", new dbus.Variant("d", 0.5));
    assert.equal(f.calls.at(-1).signature, "ssv");
    const received = [];
    const listener = (...args) => received.push(args);
    props.on("PropertiesChanged", listener);
    // Match installation finishes asynchronously after the daemon reply.
    await new Promise((resolve) => setImmediate(resolve));
    const signal = dbus.Message.newSignal(
      playerPath,
      propertiesInterface,
      "PropertiesChanged",
      "sa{sv}as",
      [playerInterface, { PlaybackStatus: status }, []],
    );
    signal.sender = ":1.200";
    f.connection.emit("message", signal);
    assert.deepEqual(received, [
      [playerInterface, { PlaybackStatus: status }, []],
    ]);
    props.removeListener("PropertiesChanged", listener);
    assert(f.calls.some((m) => m.member === "AddMatch"));
    assert.equal(f.bus._signals.eventNames().length, 0);
    assert.deepEqual(f.errors, []);
  } finally {
    f.bus.disconnect();
  }
  assert.equal(f.disconnected, 1);
}

async function verifyBuilder(appRequire) {
  const { xml2js, dbus } = libraries(appRequire);
  const parsed = await new xml2js.Parser().parseStringPromise(playerXml);
  assert.equal(
    parsed.node.interface[0].annotation[0].$.value,
    'Music & video <fixture> "player"',
  );
  assert.equal(parsed.node.node[0].node[0].$.name, "Tracks");
  const f = createFixture(appRequire);
  try {
    // This is the actual headless Builder created by MessageBus, with the
    // default parser structures used by the library, including annotations.
    const rebuilt = f.bus._builder.buildObject(parsed);
    assert(!rebuilt.startsWith("<?xml"));
    assert.deepEqual(
      await new xml2js.Parser().parseStringPromise(rebuilt),
      parsed,
    );
    const proxy = await f.bus.getProxyObject(player, playerPath, rebuilt);
    await proxy.getInterface(playerInterface).Play();

    class Service extends dbus.interface.Interface {
      constructor() {
        super(playerInterface);
      }
      Play() {}
      Seeked(position) {
        return position;
      }
    }
    Service.configureMembers({
      methods: { Play: { inSignature: "", outSignature: "" } },
      properties: { PlaybackStatus: { signature: "s", access: "read" } },
      signals: { Seeked: { signature: "x" } },
    });
    f.bus.export(playerPath, new Service());
    const generated = f.bus._introspect(playerPath);
    assert(generated.startsWith("<!DOCTYPE node"));
    const roundTrip = await f.bus.getProxyObject(player, playerPath, generated);
    assert.deepEqual(roundTrip.getInterface(playerInterface).$signals, [
      { name: "Seeked", signature: "x" },
    ]);
    await roundTrip.getInterface(playerInterface).Play();
    assert.deepEqual(f.errors, []);
  } finally {
    f.bus.disconnect();
  }
}

async function verifyMalformed(appRequire) {
  // Both XML syntax errors and valid XML with an unusable root must reject
  // through the asynchronous Introspect reply path. Vitest/Playwright also
  // fail on unhandled rejections; no global handlers swallow them here.
  for (const xml of ["<node><interface></node>", "<node>", "", "<wrong/>"]) {
    const f = createFixture(appRequire, { xml });
    try {
      await assert.rejects(f.bus.getProxyObject(player, playerPath));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(f.errors, []);
    } finally {
      f.bus.disconnect();
    }
    assert.equal(f.disconnected, 1);
  }
}

async function verifyDangerousKeys(appRequire) {
  const { xml2js } = libraries(appRequire);
  const parsed = await new xml2js.Parser().parseStringPromise(
    "<node><__proto__><fu02Marker>synthetic</fu02Marker></__proto__></node>",
  );
  // 0.4.23 replaces this individual parsed object's prototype. This does not
  // demonstrate mutation of global Object.prototype or a Decker exploit.
  assert.equal(Object.getPrototypeOf(parsed.node), Object.prototype);
  assert.equal(Object.hasOwn(parsed.node, "__proto__"), true);
  assert.equal(parsed.node.fu02Marker, undefined);
  assert.equal(Object.prototype.fu02Marker, undefined);
}

module.exports = {
  busName,
  busPath,
  player,
  secondPlayer,
  playerPath,
  playerInterface,
  createFixture,
  libraries,
  scenarios: {
    verifyProxy,
    verifyBuilder,
    verifyMalformed,
    verifyDangerousKeys,
  },
};
