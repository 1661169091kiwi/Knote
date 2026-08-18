package com.knote.capacitor.android;

import java.io.StringReader;
import java.io.UnsupportedEncodingException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.parsers.ParserConfigurationException;
import javax.xml.parsers.SAXParserFactory;
import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXNotRecognizedException;
import org.xml.sax.SAXNotSupportedException;
import org.xml.sax.SAXParseException;
import org.xml.sax.XMLReader;
import org.xml.sax.helpers.DefaultHandler;

final class SearchParser {
    private static final int MAX_TITLE_LENGTH = 300;
    private static final int MAX_SNIPPET_LENGTH = 1000;
    private static final int MAX_URL_LENGTH = 2048;
    private static final int MAX_HTML_LENGTH = 2 * 1024 * 1024;
    private static final int MAX_PARSED_RESULTS = 20;
    private static final int MAX_BLOCK_LENGTH = 256 * 1024;
    private static final int MAX_XML_DEPTH = 32;
    private static final int MAX_XML_ELEMENTS = 10_000;
    private static final int MAX_RSS_ITEMS = 200;

    private static final Pattern HREF = Pattern.compile("(?is)\\bhref\\s*=\\s*([\"'])(.*?)\\1");
    private static final Pattern TAG = Pattern.compile("(?is)<[^>]{0,4096}>");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern SCRIPT_OR_STYLE = Pattern.compile("(?is)<(?:script|style)\\b");
    private static final Pattern DANGEROUS_TAG = Pattern.compile("(?is)<(?:iframe|object|embed|svg|math)\\b");
    private static final Pattern HTML_COMMENT = Pattern.compile("(?is)<!--[\\s\\S]*?-->");
    private static final Pattern DUCK_TITLE = Pattern.compile(
        "(?is)<a\\b([^>]*\\bclass\\s*=\\s*([\"'])[^\"']*\\bresult__a\\b[^\"']*\\2[^>]*)>(.*?)</a>"
    );
    private static final Pattern DUCK_SNIPPET = Pattern.compile(
        "(?is)<a\\b[^>]*\\bclass\\s*=\\s*([\"'])[^\"']*\\bresult__snippet\\b[^\"']*\\1[^>]*>(.*?)</a>"
    );
    private static final Pattern MOJEEK_TITLE = Pattern.compile(
        "(?is)<h2\\b[^>]*>\\s*<a\\b([^>]*)>(.*?)</a>"
    );
    private static final Pattern MOJEEK_SNIPPET = Pattern.compile(
        "(?is)<p\\b[^>]*\\bclass\\s*=\\s*([\"'])[^\"']*\\bs\\b[^\"']*\\1[^>]*>(.*?)</p>"
    );
    private static final Pattern CLASS_ATTRIBUTE = Pattern.compile("(?is)\\bclass\\s*=\\s*([\"'])(.*?)\\1");
    private static final Pattern BLOCKED_TITLE = Pattern.compile(
        "(?is)<title[^>]*>[^<]*(?:captcha|access denied|attention required|robot check|just a moment)"
    );
    private static final Pattern BLOCKED_MARKUP = Pattern.compile(
        "(?is)<(?:form|div|section)\\b[^>]*(?:id|class)\\s*=\\s*([\"'])[^\"']*(?:captcha|challenge|robot-check)[^\"']*\\1"
    );
    private static final Pattern BLOCKED_TEXT = Pattern.compile(
        "(?is)(?:verify (?:that )?you are human|unusual traffic from your computer network|automated queries|bots use duckduckgo too)"
    );
    private static final Pattern NO_RESULTS = Pattern.compile(
        "(?is)(?:\\bno (?:web )?results?(?:\\s+(?:found|returned|were found))?\\b|" +
        "\\b(?:your search|query) did not match any\\b|\\b0 results?\\b|" +
        "\u6ca1\u6709\u627e\u5230(?:\u4efb\u4f55)?(?:\u76f8\u5173)?\u7ed3\u679c|" +
        "\u65e0\u641c\u7d22\u7ed3\u679c)"
    );

    private SearchParser() {}

    static List<Result> parse(String engine, String document, int max) {
        return parseResponse(engine, document, max).results;
    }

    static ParseOutcome parseResponse(String engine, String document, int max) {
        if (document == null || document.length() > MAX_HTML_LENGTH || max <= 0 || max > MAX_PARSED_RESULTS || engine == null) {
            return ParseOutcome.invalid();
        }
        switch (engine) {
            case "bing":
                return parseBingRss(document, max);
            case "duckduckgo": {
                if (isBlockedDocument(document)) {
                    return ParseOutcome.blocked();
                }
                List<Result> results = parseBlocks(
                    document,
                    "<div",
                    "web-result",
                    DUCK_TITLE,
                    1,
                    3,
                    DUCK_SNIPPET,
                    2,
                    max,
                    true
                );
                return !results.isEmpty() || isExplicitNoResults("duckduckgo", document)
                    ? ParseOutcome.valid(results)
                    : ParseOutcome.invalid();
            }
            case "mojeek": {
                if (isBlockedDocument(document)) {
                    return ParseOutcome.blocked();
                }
                List<Result> results = parseMojeek(document, max);
                return !results.isEmpty() || isExplicitNoResults("mojeek", document)
                    ? ParseOutcome.valid(results)
                    : ParseOutcome.invalid();
            }
            default:
                return ParseOutcome.invalid();
        }
    }

    private static boolean isBlockedDocument(String document) {
        return BLOCKED_TITLE.matcher(document).find() ||
            BLOCKED_MARKUP.matcher(document).find() ||
            BLOCKED_TEXT.matcher(document).find();
    }

    private static boolean isExplicitNoResults(String engine, String document) {
        if (
            !NO_RESULTS.matcher(document).find() ||
            (indexOfIgnoreCase(document, "<html", 0) < 0 && indexOfIgnoreCase(document, "<!doctype html", 0) < 0)
        ) {
            return false;
        }
        if ("duckduckgo".equals(engine)) {
            return indexOfIgnoreCase(document, "duckduckgo", 0) >= 0 ||
                indexOfIgnoreCase(document, "no-results", 0) >= 0;
        }
        return "mojeek".equals(engine) && (
            indexOfIgnoreCase(document, "mojeek", 0) >= 0 ||
            indexOfIgnoreCase(document, "no-results", 0) >= 0
        );
    }

    private static ParseOutcome parseBingRss(String xml, int max) {
        if (
            indexOfIgnoreCase(xml, "<!doctype", 0) >= 0 ||
            indexOfIgnoreCase(xml, "<!entity", 0) >= 0
        ) {
            return ParseOutcome.invalid();
        }
        BingRssHandler handler = new BingRssHandler(max);
        try {
            SAXParserFactory factory = SAXParserFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setFeature("http://xml.org/sax/features/validation", false);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            setOptionalFeature(factory, "http://apache.org/xml/features/disallow-doctype-decl", true);
            setOptionalFeature(factory, "http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            try {
                factory.setXIncludeAware(false);
            } catch (UnsupportedOperationException ignored) {
                // Android's parser does not process XInclude when this setting is unsupported.
            }
            XMLReader reader = factory.newSAXParser().getXMLReader();
            reader.setFeature("http://xml.org/sax/features/validation", false);
            reader.setFeature("http://xml.org/sax/features/external-general-entities", false);
            reader.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            setOptionalFeature(reader, "http://apache.org/xml/features/disallow-doctype-decl", true);
            setOptionalFeature(reader, "http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            reader.setEntityResolver(handler);
            reader.setContentHandler(handler);
            reader.setErrorHandler(handler);
            reader.setDTDHandler(handler);
            reader.parse(new InputSource(new StringReader(xml)));
            return handler.isValid() ? ParseOutcome.valid(handler.results) : ParseOutcome.invalid();
        } catch (ParserConfigurationException | SAXException | java.io.IOException | RuntimeException exception) {
            return ParseOutcome.invalid();
        }
    }

    private static void setOptionalFeature(SAXParserFactory factory, String feature, boolean value) {
        try {
            factory.setFeature(feature, value);
        } catch (ParserConfigurationException | SAXNotRecognizedException | SAXNotSupportedException ignored) {
            // The lexical declaration check and disabled entity features remain mandatory.
        }
    }

    private static void setOptionalFeature(XMLReader reader, String feature, boolean value) {
        try {
            reader.setFeature(feature, value);
        } catch (SAXNotRecognizedException | SAXNotSupportedException ignored) {
            // Android Expat rejects these Xerces feature names but does not load external entities.
        }
    }

    private static List<Result> parseBlocks(
        String html,
        String tagStart,
        String requiredClass,
        Pattern titlePattern,
        int titleAttributesGroup,
        int titleTextGroup,
        Pattern snippetPattern,
        int snippetTextGroup,
        int max,
        boolean unwrapDuckDuckGo
    ) {
        List<Result> results = new ArrayList<>();
        int cursor = 0;
        int scanned = 0;
        while (results.size() < max) {
            if (++scanned > 200) {
                break;
            }
            int start = findOpeningTagWithClass(html, tagStart, requiredClass, cursor);
            if (start < 0) {
                break;
            }
            int next = findOpeningTagWithClass(html, tagStart, requiredClass, start + tagStart.length());
            int end = next < 0 ? Math.min(html.length(), start + MAX_BLOCK_LENGTH + 1) : next;
            String block = html.substring(start, end);
            addResult(results, block, titlePattern, titleAttributesGroup, titleTextGroup, snippetPattern, snippetTextGroup, unwrapDuckDuckGo);
            cursor = next < 0 ? html.length() : next;
        }
        return results;
    }

    private static List<Result> parseMojeek(String html, int max) {
        List<Result> results = new ArrayList<>();
        int cursor = 0;
        int scanned = 0;
        while (results.size() < max) {
            if (++scanned > 200) {
                break;
            }
            int startMarker = indexOfIgnoreCase(html, "<!--rs-->", cursor);
            if (startMarker < 0) {
                break;
            }
            int start = startMarker + "<!--rs-->".length();
            int end = indexOfIgnoreCase(html, "<!--re-->", start);
            if (end < 0) {
                break;
            }
            if (end - start <= MAX_BLOCK_LENGTH) {
                addResult(results, html.substring(start, end), MOJEEK_TITLE, 1, 2, MOJEEK_SNIPPET, 2, false);
            }
            cursor = end + "<!--re-->".length();
        }
        return results;
    }

    private static void addResult(
        List<Result> output,
        String block,
        Pattern titlePattern,
        int titleAttributesGroup,
        int titleTextGroup,
        Pattern snippetPattern,
        int snippetTextGroup,
        boolean unwrapDuckDuckGo
    ) {
        if (SCRIPT_OR_STYLE.matcher(block).find() || DANGEROUS_TAG.matcher(block).find()) {
            return;
        }
        if (block.length() > MAX_BLOCK_LENGTH) {
            return;
        }
        Matcher titleMatcher = titlePattern.matcher(block);
        if (!titleMatcher.find()) {
            return;
        }
        if (titleMatcher.group(titleAttributesGroup).length() > 4096) {
            return;
        }
        if (titleMatcher.group(titleTextGroup).length() > 16 * 1024) {
            return;
        }
        Matcher hrefMatcher = HREF.matcher(titleMatcher.group(titleAttributesGroup));
        if (!hrefMatcher.find()) {
            return;
        }
        String hrefValue = hrefMatcher.group(2);
        if (hrefMatcher.find()) {
            return;
        }

        String title = cleanText(titleMatcher.group(titleTextGroup), MAX_TITLE_LENGTH);
        String href = decodeEntities(hrefValue);
        String url = normalizeResultUrl(href, unwrapDuckDuckGo);
        if (title.isEmpty() || url == null) {
            return;
        }

        String snippet = "";
        Matcher snippetMatcher = snippetPattern.matcher(block.substring(titleMatcher.end()));
        if (snippetMatcher.find()) {
            String snippetHtml = snippetMatcher.group(snippetTextGroup);
            if (snippetHtml.length() <= 64 * 1024) {
                snippet = cleanText(snippetHtml, MAX_SNIPPET_LENGTH);
            }
        }
        output.add(new Result(title, url, snippet));
    }

    private static int findOpeningTagWithClass(String html, String tagStart, String requiredClass, int from) {
        int cursor = from;
        while (true) {
            int start = indexOfIgnoreCase(html, tagStart, cursor);
            if (start < 0) {
                return -1;
            }
            int afterName = start + tagStart.length();
            if (afterName < html.length()) {
                char boundary = html.charAt(afterName);
                if (!(Character.isWhitespace(boundary) || boundary == '>')) {
                    cursor = afterName;
                    continue;
                }
            }
            int end = html.indexOf('>', afterName);
            if (end < 0) {
                return -1;
            }
            if (end - start > 4096) {
                cursor = end + 1;
                continue;
            }
            String openingTag = html.substring(start, end + 1);
            if (hasClass(openingTag, requiredClass)) {
                return start;
            }
            cursor = end + 1;
        }
    }

    private static boolean hasClass(String openingTag, String requiredClass) {
        Matcher matcher = CLASS_ATTRIBUTE.matcher(openingTag);
        if (!matcher.find()) {
            return false;
        }
        String classValue = matcher.group(2);
        if (classValue.length() > 1024) {
            return false;
        }
        if (matcher.find()) {
            return false;
        }
        String[] classes = classValue.split("\\s+");
        if (classes.length > 64) {
            return false;
        }
        for (String className : classes) {
            if (className.equals(requiredClass)) {
                return true;
            }
        }
        return false;
    }

    private static String normalizeResultUrl(String input, boolean unwrapDuckDuckGo) {
        if (input == null) {
            return null;
        }
        String candidate = input.trim();
        if (!candidate.equals(input)) {
            return null;
        }
        if (unwrapDuckDuckGo) {
            String absolute = candidate.startsWith("//") ? "https:" + candidate : candidate;
            boolean wasDuckDuckGoRedirect = false;
            try {
                if (absolute.length() > MAX_URL_LENGTH * 4) {
                    return null;
                }
                URI redirect = new URI(absolute);
                String host = redirect.getHost();
                if (
                    "https".equalsIgnoreCase(redirect.getScheme()) &&
                    host != null &&
                    (host.equalsIgnoreCase("duckduckgo.com") || host.equalsIgnoreCase("html.duckduckgo.com")) &&
                    "/l/".equals(redirect.getPath())
                ) {
                    String target = queryParameter(redirect.getRawQuery(), "uddg");
                    if (target == null) {
                        return null;
                    }
                    candidate = target;
                    wasDuckDuckGoRedirect = true;
                } else if (host != null && (host.equalsIgnoreCase("duckduckgo.com") || host.equalsIgnoreCase("html.duckduckgo.com"))) {
                    return null;
                }
            } catch (URISyntaxException ignored) {
                return null;
            }
            if (!wasDuckDuckGoRedirect) {
                return null;
            }
        }
        if (candidate.length() > MAX_URL_LENGTH || containsForbiddenText(candidate)) {
            return null;
        }
        if (candidate.indexOf('&') >= 0 && candidate.indexOf('?') < 0) {
            return null;
        }
        if (candidate.indexOf('\\') >= 0) {
            return null;
        }
        try {
            URI uri = new URI(candidate);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost();
            if (
                !scheme.equals("https") ||
                host == null ||
                host.isEmpty() ||
                uri.getUserInfo() != null ||
                uri.getRawFragment() != null ||
                !isSafeHost(host)
            ) {
                return null;
            }
            int port = uri.getPort();
            if (port != -1 && port != 443) {
                return null;
            }
            if (uri.getRawPath() != null && containsEncodedSeparatorOrControl(uri.getRawPath())) {
                return null;
            }
            if (uri.getRawQuery() != null && containsEncodedControl(uri.getRawQuery())) {
                return null;
            }
            if (isPrivateAddressLiteral(host)) {
                return null;
            }
            String output = uri.toASCIIString();
            return output.length() <= MAX_URL_LENGTH ? output : null;
        } catch (URISyntaxException | IllegalArgumentException exception) {
            return null;
        }
    }

    private static String queryParameter(String rawQuery, String name) {
        if (rawQuery == null) {
            return null;
        }
        if (rawQuery.length() > MAX_URL_LENGTH * 4) {
            return null;
        }
        String result = null;
        String rawResult = null;
        for (String part : rawQuery.split("&")) {
            int separator = part.indexOf('=');
            String rawName = separator < 0 ? part : part.substring(0, separator);
            if (rawName.length() > 64) {
                continue;
            }
            if (!decodeUrlComponent(rawName).equals(name)) {
                continue;
            }
            if (result != null) {
                return null;
            }
            String rawValue = separator < 0 ? "" : part.substring(separator + 1);
            if (rawValue.length() > MAX_URL_LENGTH * 3) {
                return null;
            }
            rawResult = rawValue;
            result = decodeUrlComponent(rawValue);
            if (result.isEmpty()) {
                return null;
            }
        }
        if (result == null || rawResult == null) {
            return null;
        }
        String encoded = encodeUrlComponent(result);
        return encoded != null && encoded.equalsIgnoreCase(rawResult) ? result : null;
    }

    private static String decodeUrlComponent(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (IllegalArgumentException | UnsupportedEncodingException exception) {
            return "";
        }
    }

    private static String encodeUrlComponent(String value) {
        try {
            return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20");
        } catch (IllegalArgumentException | UnsupportedEncodingException exception) {
            return null;
        }
    }

    private static String cleanText(String html, int maxLength) {
        String withoutComments = HTML_COMMENT.matcher(html).replaceAll(" ");
        String withoutTags = TAG.matcher(withoutComments).replaceAll(" ");
        if (withoutTags.indexOf('<') >= 0 || withoutTags.indexOf('>') >= 0) {
            return "";
        }
        String decoded = decodeEntities(withoutTags);
        StringBuilder filtered = new StringBuilder(decoded.length());
        for (int offset = 0; offset < decoded.length();) {
            char unit = decoded.charAt(offset);
            if (Character.isHighSurrogate(unit)) {
                if (offset + 1 >= decoded.length() || !Character.isLowSurrogate(decoded.charAt(offset + 1))) {
                    filtered.append(' ');
                    offset++;
                    continue;
                }
            } else if (Character.isLowSurrogate(unit)) {
                filtered.append(' ');
                offset++;
                continue;
            }
            int codePoint = decoded.codePointAt(offset);
            offset += Character.charCount(codePoint);
            if (PathPolicy.isForbiddenCodePoint(codePoint) || codePoint == 0xfffd) {
                filtered.append(' ');
            } else {
                filtered.appendCodePoint(codePoint);
            }
        }
        String collapsed = WHITESPACE.matcher(filtered).replaceAll(" ").trim();
        StringBuilder output = new StringBuilder(Math.min(collapsed.length(), maxLength));
        int count = 0;
        for (int offset = 0; offset < collapsed.length() && count < maxLength;) {
            int codePoint = collapsed.codePointAt(offset);
            offset += Character.charCount(codePoint);
            output.appendCodePoint(codePoint);
            count++;
        }
        return output.toString().trim();
    }

    private static String cleanXmlText(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        String withoutComments = HTML_COMMENT.matcher(value).replaceAll(" ");
        String withoutTags = TAG.matcher(withoutComments).replaceAll(" ");
        if (withoutTags.indexOf('<') >= 0 || withoutTags.indexOf('>') >= 0) {
            return "";
        }
        StringBuilder filtered = new StringBuilder(Math.min(withoutTags.length(), maxLength));
        int count = 0;
        for (int offset = 0; offset < withoutTags.length() && count < maxLength;) {
            char unit = withoutTags.charAt(offset);
            if (Character.isHighSurrogate(unit)) {
                if (offset + 1 >= withoutTags.length() || !Character.isLowSurrogate(withoutTags.charAt(offset + 1))) {
                    filtered.append(' ');
                    offset++;
                    count++;
                    continue;
                }
            } else if (Character.isLowSurrogate(unit)) {
                filtered.append(' ');
                offset++;
                count++;
                continue;
            }
            int codePoint = withoutTags.codePointAt(offset);
            offset += Character.charCount(codePoint);
            if (PathPolicy.isForbiddenCodePoint(codePoint) || codePoint == 0xfffd) {
                filtered.append(' ');
            } else {
                filtered.appendCodePoint(codePoint);
            }
            count++;
        }
        return WHITESPACE.matcher(filtered).replaceAll(" ").trim();
    }

    private static String decodeEntities(String input) {
        if (input.length() > MAX_BLOCK_LENGTH) {
            return "";
        }
        StringBuilder output = new StringBuilder(input.length());
        for (int index = 0; index < input.length();) {
            char character = input.charAt(index);
            if (character != '&') {
                output.append(character);
                index++;
                continue;
            }
            int semicolon = input.indexOf(';', index + 1);
            if (semicolon < 0 || semicolon - index > 12) {
                output.append('&');
                index++;
                continue;
            }
            String entity = input.substring(index + 1, semicolon);
            Integer decoded = decodeEntity(entity);
            if (
                decoded == null ||
                !Character.isValidCodePoint(decoded) ||
                (decoded >= Character.MIN_SURROGATE && decoded <= Character.MAX_SURROGATE)
            ) {
                output.append('&');
                index++;
            } else {
                output.appendCodePoint(decoded);
                index = semicolon + 1;
            }
        }
        return output.toString();
    }

    private static Integer decodeEntity(String entity) {
        switch (entity) {
            case "amp":
                return (int) '&';
            case "apos":
            case "#39":
                return (int) '\'';
            case "quot":
                return (int) '"';
            case "lt":
                return (int) '<';
            case "gt":
                return (int) '>';
            case "nbsp":
                return (int) ' ';
            default:
                try {
                    if (entity.startsWith("#x") || entity.startsWith("#X")) {
                        return Integer.parseInt(entity.substring(2), 16);
                    }
                    if (entity.startsWith("#")) {
                        return Integer.parseInt(entity.substring(1));
                    }
                } catch (NumberFormatException ignored) {
                    return null;
                }
                return null;
        }
    }

    private static boolean containsForbiddenText(String value) {
        for (int offset = 0; offset < value.length();) {
            char unit = value.charAt(offset);
            if (Character.isHighSurrogate(unit)) {
                if (offset + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(offset + 1))) {
                    return true;
                }
            } else if (Character.isLowSurrogate(unit)) {
                return true;
            }
            int codePoint = value.codePointAt(offset);
            if (PathPolicy.isForbiddenCodePoint(codePoint) || Character.isWhitespace(codePoint)) {
                return true;
            }
            offset += Character.charCount(codePoint);
        }
        return false;
    }

    private static boolean isSafeHost(String host) {
        if (host.length() > 253 || host.endsWith(".") || host.startsWith(".")) {
            return false;
        }
        for (int index = 0; index < host.length(); index++) {
            char character = host.charAt(index);
            if (!(
                (character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') ||
                character == '-' ||
                character == '.'
            )) {
                return false;
            }
        }
        if (host.contains("..")) {
            return false;
        }
        return true;
    }

    private static boolean isPrivateAddressLiteral(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) {
            return containsNumericHostSyntax(host) ||
                host.equalsIgnoreCase("localhost") ||
                host.toLowerCase(Locale.ROOT).endsWith(".localhost");
        }
        int[] octets = new int[4];
        for (int index = 0; index < parts.length; index++) {
            if (parts[index].isEmpty() || parts[index].length() > 3) {
                return containsNumericHostSyntax(host);
            }
            if (parts[index].length() > 1 && parts[index].charAt(0) == '0') {
                return true;
            }
            try {
                octets[index] = Integer.parseInt(parts[index]);
            } catch (NumberFormatException exception) {
                return containsNumericHostSyntax(host);
            }
            if (octets[index] < 0 || octets[index] > 255) {
                return true;
            }
        }
        return octets[0] == 0 ||
            octets[0] == 10 ||
            octets[0] == 127 ||
            (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127) ||
            (octets[0] == 169 && octets[1] == 254) ||
            (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
            (octets[0] == 192 && octets[1] == 168) ||
            octets[0] >= 224;
    }

    private static boolean containsNumericHostSyntax(String host) {
        if (host.isEmpty()) {
            return false;
        }
        boolean hasDigit = false;
        for (int index = 0; index < host.length(); index++) {
            char character = host.charAt(index);
            if (character >= '0' && character <= '9') {
                hasDigit = true;
            } else if (!(
                character == '.' ||
                character == 'x' ||
                character == 'X' ||
                (character >= 'a' && character <= 'f') ||
                (character >= 'A' && character <= 'F')
            )) {
                return false;
            }
        }
        return hasDigit;
    }

    private static boolean containsEncodedSeparatorOrControl(String value) {
        String lower = value.toLowerCase(Locale.ROOT);
        return lower.contains("%2f") ||
            lower.contains("%5c") ||
            lower.contains("%00") ||
            lower.contains("%0a") ||
            lower.contains("%0d");
    }

    private static boolean containsEncodedControl(String value) {
        String lower = value.toLowerCase(Locale.ROOT);
        return lower.contains("%00") || lower.contains("%0a") || lower.contains("%0d");
    }

    private static int indexOfIgnoreCase(String value, String target, int from) {
        int max = value.length() - target.length();
        for (int index = Math.max(0, from); index <= max; index++) {
            if (value.regionMatches(true, index, target, 0, target.length())) {
                return index;
            }
        }
        return -1;
    }

    static final class ParseOutcome {
        final boolean valid;
        final boolean blocked;
        final List<Result> results;

        private ParseOutcome(boolean valid, boolean blocked, List<Result> results) {
            this.valid = valid;
            this.blocked = blocked;
            this.results = results;
        }

        static ParseOutcome valid(List<Result> results) {
            return new ParseOutcome(true, false, Collections.unmodifiableList(new ArrayList<>(results)));
        }

        static ParseOutcome invalid() {
            return new ParseOutcome(false, false, Collections.emptyList());
        }

        static ParseOutcome blocked() {
            return new ParseOutcome(false, true, Collections.emptyList());
        }
    }

    private static final class BingRssHandler extends DefaultHandler {
        final List<Result> results = new ArrayList<>();
        private final int max;
        private int depth;
        private int elementCount;
        private int itemCount;
        private boolean rootOpen;
        private boolean rootClosed;
        private boolean channelOpen;
        private boolean channelClosed;
        private boolean itemOpen;
        private boolean itemInvalid;
        private boolean hasTitle;
        private boolean hasLink;
        private boolean hasDescription;
        private String activeField;
        private StringBuilder activeText;
        private String itemTitle;
        private String itemLink;
        private String itemDescription;

        BingRssHandler(int max) {
            this.max = max;
        }

        @Override
        public void startElement(String uri, String localName, String qName, Attributes attributes) throws SAXException {
            if (++elementCount > MAX_XML_ELEMENTS || ++depth > MAX_XML_DEPTH) {
                throw new SAXException("RSS document exceeds structural limits");
            }
            String name = elementName(localName, qName);
            if (name == null) {
                throw new SAXException("RSS document has an invalid element name");
            }
            if (depth == 1) {
                if (rootOpen || rootClosed || !isUnqualified(uri) || !"rss".equals(name)) {
                    throw new SAXException("RSS root is invalid");
                }
                rootOpen = true;
                return;
            }
            if (!rootOpen || rootClosed) {
                throw new SAXException("RSS root is not open");
            }
            if (depth == 2) {
                if (channelOpen || channelClosed || !isUnqualified(uri) || !"channel".equals(name)) {
                    throw new SAXException("RSS channel is invalid");
                }
                channelOpen = true;
                return;
            }
            if (!channelOpen || channelClosed) {
                throw new SAXException("RSS content is outside its channel");
            }
            if (depth == 3 && isUnqualified(uri) && "item".equals(name)) {
                if (itemOpen || ++itemCount > MAX_RSS_ITEMS) {
                    throw new SAXException("RSS item limit exceeded");
                }
                beginItem();
                return;
            }
            if (!itemOpen) {
                return;
            }
            if (depth == 4 && isUnqualified(uri) && isItemField(name)) {
                beginField(name, attributes);
            } else if (activeField != null) {
                itemInvalid = true;
            }
        }

        @Override
        public void characters(char[] characters, int start, int length) {
            if (activeField == null || activeText == null || depth != 4 || itemInvalid || length <= 0) {
                return;
            }
            int limit = "description".equals(activeField) ? 64 * 1024 : 16 * 1024;
            if (length > limit - activeText.length()) {
                itemInvalid = true;
                return;
            }
            activeText.append(characters, start, length);
        }

        @Override
        public void endElement(String uri, String localName, String qName) throws SAXException {
            String name = elementName(localName, qName);
            if (name == null || depth <= 0) {
                throw new SAXException("RSS document is unbalanced");
            }
            if (depth == 4 && activeField != null && activeField.equals(name)) {
                finishField();
            }
            if (depth == 3 && itemOpen && isUnqualified(uri) && "item".equals(name)) {
                finishItem();
            } else if (depth == 2 && isUnqualified(uri) && "channel".equals(name)) {
                if (!channelOpen || itemOpen) {
                    throw new SAXException("RSS channel closed unexpectedly");
                }
                channelOpen = false;
                channelClosed = true;
            } else if (depth == 1 && isUnqualified(uri) && "rss".equals(name)) {
                if (!rootOpen || !channelClosed) {
                    throw new SAXException("RSS root closed unexpectedly");
                }
                rootOpen = false;
                rootClosed = true;
            }
            depth--;
        }

        @Override
        public void endDocument() throws SAXException {
            if (depth != 0 || rootOpen || channelOpen || itemOpen || !rootClosed || !channelClosed) {
                throw new SAXException("RSS document is incomplete");
            }
        }

        @Override
        public InputSource resolveEntity(String publicId, String systemId) throws SAXException {
            throw new SAXException("External RSS entities are forbidden");
        }

        @Override
        public void notationDecl(String name, String publicId, String systemId) throws SAXException {
            throw new SAXException("RSS declarations are forbidden");
        }

        @Override
        public void unparsedEntityDecl(String name, String publicId, String systemId, String notationName) throws SAXException {
            throw new SAXException("RSS entities are forbidden");
        }

        @Override
        public void processingInstruction(String target, String data) throws SAXException {
            throw new SAXException("RSS processing instructions are forbidden");
        }

        @Override
        public void skippedEntity(String name) throws SAXException {
            throw new SAXException("RSS entities are forbidden");
        }

        @Override
        public void warning(SAXParseException exception) throws SAXException {
            throw exception;
        }

        @Override
        public void error(SAXParseException exception) throws SAXException {
            throw exception;
        }

        @Override
        public void fatalError(SAXParseException exception) throws SAXException {
            throw exception;
        }

        boolean isValid() {
            return rootClosed && channelClosed && depth == 0;
        }

        private void beginItem() {
            itemOpen = true;
            itemInvalid = false;
            hasTitle = false;
            hasLink = false;
            hasDescription = false;
            activeField = null;
            activeText = null;
            itemTitle = null;
            itemLink = null;
            itemDescription = "";
        }

        private void beginField(String name, Attributes attributes) {
            if (activeField != null || (attributes != null && attributes.getLength() != 0)) {
                itemInvalid = true;
                return;
            }
            boolean duplicate = ("title".equals(name) && hasTitle) ||
                ("link".equals(name) && hasLink) ||
                ("description".equals(name) && hasDescription);
            if (duplicate) {
                itemInvalid = true;
                return;
            }
            if ("title".equals(name)) {
                hasTitle = true;
            } else if ("link".equals(name)) {
                hasLink = true;
            } else {
                hasDescription = true;
            }
            activeField = name;
            activeText = new StringBuilder();
        }

        private void finishField() {
            String value = activeText == null ? "" : activeText.toString();
            if ("title".equals(activeField)) {
                itemTitle = value;
            } else if ("link".equals(activeField)) {
                itemLink = value;
            } else if ("description".equals(activeField)) {
                itemDescription = value;
            }
            activeField = null;
            activeText = null;
        }

        private void finishItem() {
            if (activeField != null) {
                itemInvalid = true;
            }
            if (!itemInvalid && hasTitle && hasLink && results.size() < max) {
                String title = cleanXmlText(itemTitle, MAX_TITLE_LENGTH);
                String snippet = cleanXmlText(itemDescription, MAX_SNIPPET_LENGTH);
                String url = normalizeResultUrl(itemLink, false);
                if (!title.isEmpty() && url != null) {
                    results.add(new Result(title, url, snippet));
                }
            }
            itemOpen = false;
            activeField = null;
            activeText = null;
        }

        private static boolean isItemField(String name) {
            return "title".equals(name) || "link".equals(name) || "description".equals(name);
        }

        private static boolean isUnqualified(String uri) {
            return uri == null || uri.isEmpty();
        }

        private static String elementName(String localName, String qName) {
            String name = localName == null || localName.isEmpty() ? qName : localName;
            if (name == null || name.isEmpty() || name.length() > 64) {
                return null;
            }
            for (int index = 0; index < name.length(); index++) {
                char character = name.charAt(index);
                boolean letter = (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
                if (!(letter || character == '_' || (index > 0 && (
                    (character >= '0' && character <= '9') || character == '-' || character == '.'
                )))) {
                    return null;
                }
            }
            return name;
        }
    }

    static final class Result {
        final String title;
        final String url;
        final String snippet;

        Result(String title, String url, String snippet) {
            this.title = title;
            this.url = url;
            this.snippet = snippet;
        }
    }
}
