package com.dongguatv.bridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

public final class CatvodRuntimeBridge {
    private static final String SERVICE = "dongguatv-catvod-runtime-bridge-java";
    private static final String VERSION = "0.1.0";

    private CatvodRuntimeBridge() {
    }

    public static void main(String[] args) throws Exception {
        Map<String, String> options = parseArgs(args);
        String host = options.getOrDefault("host", "127.0.0.1");
        int port = Integer.parseInt(options.getOrDefault("port", "9977"));
        String mode = options.getOrDefault("mode", "disabled");

        if (!isLocalHost(host)) {
            throw new IllegalArgumentException("Runtime bridge refuses to bind to non-local hosts.");
        }
        if (!mode.equals("disabled") && !mode.equals("stub")) {
            mode = "disabled";
        }

        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getByName(host), port), 0);
        RuntimeState state = new RuntimeState(mode, host, port);
        server.createContext("/health", new HealthHandler(state));
        server.createContext("/runtime/search", new RuntimeHandler(state, "search"));
        server.createContext("/runtime/category", new RuntimeHandler(state, "category"));
        server.createContext("/runtime/detail", new RuntimeHandler(state, "detail"));
        server.createContext("/runtime/play", new RuntimeHandler(state, "play"));
        server.setExecutor(null);
        server.start();
        System.out.println(SERVICE + " " + VERSION + " listening on http://" + host + ":" + port);
    }

    private static Map<String, String> parseArgs(String[] args) {
        Map<String, String> options = new HashMap<>();
        for (int i = 0; i < args.length; i++) {
            String item = args[i];
            if (!item.startsWith("--")) {
                continue;
            }
            String key = item.substring(2);
            if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
                options.put(key, args[i + 1]);
                i++;
            } else {
                options.put(key, "true");
            }
        }
        return options;
    }

    private static boolean isLocalHost(String host) {
        String normalized = host == null ? "" : host.trim().toLowerCase();
        return normalized.equals("127.0.0.1") || normalized.equals("localhost") || normalized.equals("::1");
    }

    private static final class RuntimeState {
        final String mode;
        final String host;
        final int port;
        final Instant startedAt;

        RuntimeState(String mode, String host, int port) {
            this.mode = mode;
            this.host = host;
            this.port = port;
            this.startedAt = Instant.now();
        }
    }

    private static final class HealthHandler implements HttpHandler {
        private final RuntimeState state;

        HealthHandler(RuntimeState state) {
            this.state = state;
        }

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"ok\":false,\"status\":\"method-not-allowed\"}");
                return;
            }
            String body = "{"
                + "\"service\":\"" + SERVICE + "\","
                + "\"version\":\"" + VERSION + "\","
                + "\"status\":\"available\","
                + "\"safeMode\":true,"
                + "\"runtime\":{"
                + "\"mode\":\"" + escapeJson(state.mode) + "\","
                + "\"configured\":" + state.mode.equals("stub") + ","
                + "\"pluginExecutionEnabled\":false,"
                + "\"host\":\"" + escapeJson(state.host) + "\","
                + "\"port\":" + state.port + ","
                + "\"startedAt\":\"" + escapeJson(state.startedAt.toString()) + "\""
                + "}"
                + "}";
            sendJson(exchange, 200, body);
        }
    }

    private static final class RuntimeHandler implements HttpHandler {
        private final RuntimeState state;
        private final String operation;

        RuntimeHandler(RuntimeState state, String operation) {
            this.state = state;
            this.operation = operation;
        }

        @Override
        public void handle(HttpExchange exchange) throws IOException {
            if (!"POST".equals(exchange.getRequestMethod())) {
                sendJson(exchange, 405, "{\"ok\":false,\"status\":\"method-not-allowed\"}");
                return;
            }
            drain(exchange.getRequestBody());

            if (state.mode.equals("stub")) {
                String body = "{"
                    + "\"ok\":true,"
                    + "\"status\":\"stub\","
                    + "\"operation\":\"" + escapeJson(operation) + "\","
                    + "\"result\":" + defaultResult(operation) + ","
                    + "\"message\":\"Java runtime bridge stub mode is active. No TVBox plugin code was executed.\""
                    + "}";
                sendJson(exchange, 200, body);
                return;
            }

            String body = "{"
                + "\"ok\":false,"
                + "\"status\":\"runtime-not-configured\","
                + "\"operation\":\"" + escapeJson(operation) + "\","
                + "\"message\":\"Java runtime bridge is running, but plugin execution is not configured.\""
                + "}";
            sendJson(exchange, 200, body);
        }
    }

    private static String defaultResult(String operation) {
        if (operation.equals("search") || operation.equals("category")) {
            return "[]";
        }
        return "null";
    }

    private static void drain(InputStream input) throws IOException {
        byte[] buffer = new byte[4096];
        while (input.read(buffer) != -1) {
            // Request bodies are ignored in this protocol stub.
        }
    }

    private static void sendJson(HttpExchange exchange, int statusCode, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(statusCode, bytes.length);
        try (OutputStream output = exchange.getResponseBody()) {
            output.write(bytes);
        }
    }

    private static String escapeJson(String value) {
        if (value == null) {
            return "";
        }
        return value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\r", "\\r")
            .replace("\n", "\\n");
    }
}
