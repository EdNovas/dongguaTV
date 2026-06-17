package com.dongguatv.bridge;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CatvodRuntimeBridge {
    private static final String SERVICE = "dongguatv-catvod-runtime-bridge-java";
    private static final String VERSION = "0.2.0";

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
        if (!mode.equals("disabled") && !mode.equals("stub") && !mode.equals("reflect")) {
            mode = "disabled";
        }

        RuntimeState state = new RuntimeState(
            mode,
            host,
            port,
            options.getOrDefault("spider-jar", ""),
            options.getOrDefault("spider-class", ""),
            options.getOrDefault("spider-ext", "")
        );
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getByName(host), port), 0);
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
        final String spiderJar;
        final String spiderClass;
        final String spiderExt;
        final Instant startedAt;
        private ReflectSpiderRuntime reflectRuntime;

        RuntimeState(String mode, String host, int port, String spiderJar, String spiderClass, String spiderExt) {
            this.mode = mode;
            this.host = host;
            this.port = port;
            this.spiderJar = spiderJar == null ? "" : spiderJar.trim();
            this.spiderClass = spiderClass == null ? "" : spiderClass.trim();
            this.spiderExt = spiderExt == null ? "" : spiderExt;
            this.startedAt = Instant.now();
        }

        synchronized ReflectSpiderRuntime reflectRuntime() {
            if (reflectRuntime == null) {
                reflectRuntime = new ReflectSpiderRuntime(spiderJar, spiderClass, spiderExt);
            }
            return reflectRuntime;
        }

        boolean reflectConfigured() {
            return mode.equals("reflect") && !spiderJar.isEmpty() && !spiderClass.isEmpty() && Files.exists(Path.of(spiderJar));
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
                + "\"configured\":" + (state.mode.equals("stub") || state.reflectConfigured()) + ","
                + "\"pluginExecutionEnabled\":" + state.reflectConfigured() + ","
                + "\"spiderJarConfigured\":" + (!state.spiderJar.isEmpty() && Files.exists(Path.of(state.spiderJar))) + ","
                + "\"spiderClassConfigured\":" + !state.spiderClass.isEmpty() + ","
                + "\"spiderExtConfigured\":" + !state.spiderExt.isEmpty() + ","
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
            String requestBody = readBody(exchange.getRequestBody());

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

            if (state.mode.equals("reflect")) {
                sendJson(exchange, 200, state.reflectRuntime().call(operation, requestBody));
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

    private static final class ReflectSpiderRuntime {
        private final String spiderJar;
        private final String spiderClassName;
        private final String spiderExt;
        private URLClassLoader loader;
        private Object spider;
        private boolean initialized;

        ReflectSpiderRuntime(String spiderJar, String spiderClassName, String spiderExt) {
            this.spiderJar = spiderJar;
            this.spiderClassName = spiderClassName;
            this.spiderExt = spiderExt;
        }

        String call(String operation, String requestBody) {
            try {
                Object value = callRaw(operation, requestBody == null ? "" : requestBody);
                return success(operation, value);
            } catch (NoSuchMethodException error) {
                return failure("method-not-found", operation, "Spider method was not found for operation: " + operation);
            } catch (Throwable error) {
                return failure("reflect-error", operation, sanitizeError(error));
            }
        }

        private Object callRaw(String operation, String requestBody) throws Exception {
            Object instance = ensureSpider();
            if (operation.equals("search")) {
                String keyword = extractString(requestBody, "keyword", "wd", "query");
                boolean quick = extractBoolean(requestBody, "quick", "quickSearch", "quick_search");
                return invokeFirst(instance, "searchContent",
                    new Signature(new Class<?>[]{String.class, boolean.class}, new Object[]{keyword, quick}),
                    new Signature(new Class<?>[]{String.class}, new Object[]{keyword})
                );
            }
            if (operation.equals("category")) {
                String tid = extractString(requestBody, "tid", "typeId", "type_id", "id");
                String page = extractString(requestBody, "page", "pg");
                if (page.isEmpty()) page = "1";
                boolean filter = extractBoolean(requestBody, "filter", "filterable");
                HashMap<String, String> filters = new HashMap<>();
                return invokeFirst(instance, "categoryContent",
                    new Signature(new Class<?>[]{String.class, String.class, boolean.class, HashMap.class}, new Object[]{tid, page, filter, filters}),
                    new Signature(new Class<?>[]{String.class, String.class, boolean.class, Map.class}, new Object[]{tid, page, filter, filters}),
                    new Signature(new Class<?>[]{String.class, String.class, boolean.class}, new Object[]{tid, page, filter})
                );
            }
            if (operation.equals("detail")) {
                String id = extractString(requestBody, "id", "vod_id", "vodId");
                ArrayList<String> ids = new ArrayList<>();
                if (!id.isEmpty()) ids.add(id);
                return invokeFirst(instance, "detailContent",
                    new Signature(new Class<?>[]{List.class}, new Object[]{ids}),
                    new Signature(new Class<?>[]{String.class}, new Object[]{id})
                );
            }
            if (operation.equals("play")) {
                String flag = extractString(requestBody, "flag", "from", "playFrom");
                String id = extractString(requestBody, "id", "playUrl", "url", "vod_id");
                ArrayList<String> flags = new ArrayList<>();
                if (!flag.isEmpty()) flags.add(flag);
                return invokeFirst(instance, "playerContent",
                    new Signature(new Class<?>[]{String.class, String.class, List.class}, new Object[]{flag, id, flags}),
                    new Signature(new Class<?>[]{String.class, String.class}, new Object[]{flag, id}),
                    new Signature(new Class<?>[]{String.class}, new Object[]{id})
                );
            }
            throw new NoSuchMethodException(operation);
        }

        private synchronized Object ensureSpider() throws Exception {
            if (spider != null) {
                initSpider(spider);
                return spider;
            }
            if (spiderJar == null || spiderJar.trim().isEmpty() || !Files.exists(Path.of(spiderJar))) {
                throw new IllegalStateException("Trusted local Spider jar was not found.");
            }
            if (spiderClassName == null || spiderClassName.trim().isEmpty()) {
                throw new IllegalStateException("Trusted Spider class name is empty.");
            }
            loader = new URLClassLoader(new URL[]{Path.of(spiderJar).toUri().toURL()}, CatvodRuntimeBridge.class.getClassLoader());
            Thread.currentThread().setContextClassLoader(loader);
            Class<?> spiderClass = Class.forName(spiderClassName, true, loader);
            Object instance = spiderClass.getDeclaredConstructor().newInstance();
            initSpider(instance);
            spider = instance;
            return spider;
        }

        private void initSpider(Object instance) {
            if (initialized) {
                return;
            }
            try {
                invokeFirst(instance, "init",
                    new Signature(new Class<?>[]{Object.class, String.class}, new Object[]{null, spiderExt}),
                    new Signature(new Class<?>[]{String.class}, new Object[]{spiderExt}),
                    new Signature(new Class<?>[]{}, new Object[]{})
                );
            } catch (NoSuchMethodException ignored) {
                // Some Spider implementations do not expose init.
            } catch (Throwable ignored) {
                // Runtime calls will report concrete method errors later.
            }
            initialized = true;
        }

        private static Object invokeFirst(Object target, String methodName, Signature... signatures) throws Exception {
            NoSuchMethodException notFound = null;
            for (Signature signature : signatures) {
                try {
                    Method method = findMethod(target.getClass(), methodName, signature.types);
                    return method.invoke(target, signature.args);
                } catch (NoSuchMethodException error) {
                    notFound = error;
                } catch (InvocationTargetException error) {
                    Throwable cause = error.getCause() == null ? error : error.getCause();
                    if (cause instanceof Exception) {
                        throw (Exception) cause;
                    }
                    throw new RuntimeException(cause);
                }
            }
            throw notFound == null ? new NoSuchMethodException(methodName) : notFound;
        }

        private static Method findMethod(Class<?> type, String methodName, Class<?>[] args) throws NoSuchMethodException {
            try {
                Method method = type.getMethod(methodName, args);
                method.setAccessible(true);
                return method;
            } catch (NoSuchMethodException error) {
                Method method = type.getDeclaredMethod(methodName, args);
                method.setAccessible(true);
                return method;
            }
        }

        private static String success(String operation, Object value) {
            return "{"
                + "\"ok\":true,"
                + "\"status\":\"reflect\","
                + "\"operation\":\"" + escapeJson(operation) + "\","
                + "\"result\":" + jsonValue(value) + ","
                + "\"message\":\"Trusted local Spider method executed.\""
                + "}";
        }

        private static String failure(String status, String operation, String message) {
            return "{"
                + "\"ok\":false,"
                + "\"status\":\"" + escapeJson(status) + "\","
                + "\"operation\":\"" + escapeJson(operation) + "\","
                + "\"message\":\"" + escapeJson(message) + "\""
                + "}";
        }

        private static String sanitizeError(Throwable error) {
            String message = error.getMessage();
            if (message == null || message.trim().isEmpty()) {
                message = error.getClass().getName();
            }
            return message.replaceAll(spiderTokenPattern(), "[redacted]");
        }

        private static String spiderTokenPattern() {
            return "(?i)(token|cookie|authorization|auth|password|passwd)=[^&\\s]+";
        }
    }

    private static final class Signature {
        final Class<?>[] types;
        final Object[] args;

        Signature(Class<?>[] types, Object[] args) {
            this.types = types;
            this.args = args;
        }
    }

    private static String defaultResult(String operation) {
        if (operation.equals("search") || operation.equals("category")) {
            return "[]";
        }
        return "null";
    }

    private static String readBody(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toString(StandardCharsets.UTF_8.name());
    }

    private static String extractString(String body, String... keys) {
        if (body == null) return "";
        for (String key : keys) {
            Pattern pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
            Matcher matcher = pattern.matcher(body);
            if (matcher.find()) {
                return unescapeJson(matcher.group(1));
            }
        }
        return "";
    }

    private static boolean extractBoolean(String body, String... keys) {
        if (body == null) return false;
        for (String key : keys) {
            Pattern pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(true|false)");
            Matcher matcher = pattern.matcher(body);
            if (matcher.find()) {
                return Boolean.parseBoolean(matcher.group(1));
            }
        }
        return false;
    }

    private static String jsonValue(Object value) {
        if (value == null) {
            return "null";
        }
        String raw = String.valueOf(value).trim();
        if (raw.startsWith("{") || raw.startsWith("[") || raw.equals("true") || raw.equals("false") || raw.equals("null")) {
            return raw;
        }
        return "\"" + escapeJson(raw) + "\"";
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

    private static String unescapeJson(String value) {
        if (value == null) {
            return "";
        }
        return value
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\r", "\r");
    }
}
