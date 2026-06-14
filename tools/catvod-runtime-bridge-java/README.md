# CatVod Runtime Bridge Java

This is a local-only Java child bridge for DongguaTV's External HTTP Bridge protocol.

It is intentionally limited:

- binds only to `127.0.0.1`, `localhost`, or `::1`;
- exposes `GET /health`;
- exposes `POST /runtime/search`, `category`, `detail`, and `play`;
- does not load subscription-provided `spider.jar`, py, or js plugins;
- default mode is `disabled`;
- `stub` mode only returns empty protocol-shaped results.

## Build

Install a JDK, then run:

```powershell
powershell -ExecutionPolicy Bypass -File tools\catvod-runtime-bridge-java\build.ps1
```

Output:

```text
tools\catvod-runtime-bridge-java\dist\catvod-runtime-bridge.jar
```

If Java is not in `PATH`, pass a JDK path:

```powershell
powershell -ExecutionPolicy Bypass -File tools\catvod-runtime-bridge-java\build.ps1 -JavaHome "C:\Program Files\Eclipse Adoptium\jdk-21"
```

The build script also checks common JDK install roots such as:

- `C:\Program Files\Microsoft`
- `C:\Program Files\Java`
- `C:\Program Files\Eclipse Adoptium`
- `C:\Program Files\Zulu`

## Run Directly

```powershell
java -jar tools\catvod-runtime-bridge-java\dist\catvod-runtime-bridge.jar --host 127.0.0.1 --port 9977 --mode disabled
```

## Use With The Node Supervisor

Configure `tools\catvod-bridge\bridge-config.json`:

```json
{
  "host": "127.0.0.1",
  "port": 9978,
  "runtime": {
    "mode": "java-http",
    "allowJavaProcess": true,
    "trustedBridgeJar": true,
    "javaPath": "java",
    "catvodBridgeJarPath": "D:\\CodexWorks\\dongguaTV-enhanced-app\\tools\\catvod-runtime-bridge-java\\dist\\catvod-runtime-bridge.jar",
    "childHost": "127.0.0.1",
    "childPort": 9977,
    "javaArgs": ["-jar", "{jar}", "--host", "{host}", "--port", "{port}", "--mode", "disabled"]
  }
}
```

Then run:

```powershell
npm run bridge:catvod
```

Future CatVod execution logic should be added behind an explicit user-installed runtime configuration, not by automatically executing subscription jar links.
