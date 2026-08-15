package com.knote.capacitor.android;

import java.util.List;

public final class PureJavaTestMain {
    private PureJavaTestMain() {}

    public static void main(String[] args) throws Exception {
        testPaths();
        testBase64();
        testMimeTypes();
        testSearchParsers();
        System.out.println("PureJavaTestMain: all checks passed");
    }

    private static void testPaths() throws Exception {
        assertEquals("notes/2026/file.txt", PathPolicy.normalize("notes/2026/file.txt", false).value);
        assertEquals("caf\u00e9.txt", PathPolicy.normalize("caf\u0065\u0301.txt", false).value);
        PathPolicy.requireCanonicalInput("notes/2026/file.txt", PathPolicy.normalize("notes/2026/file.txt", false));
        assertBadPath("..");
        assertBadPath("a//b");
        assertEquals("%252e%252e", PathPolicy.normalize("%252e%252e", false).value);
        assertEquals("a%255cb", PathPolicy.normalize("a%255cb", false).value);
        assertEquals("a%b", PathPolicy.normalize("a%b", false).value);
        assertEquals("a%20b", PathPolicy.normalize("a%20b", false).value);
        assertBadPath("https:payload");
        assertBadPath("a\u202eb");
        assertBadPath("a\ud800b");
    }

    private static void testBase64() throws Exception {
        assertEquals(1, Base64Policy.validateAndGetDecodedLength("Zg=="));
        assertEquals(3, Base64Policy.validateAndGetDecodedLength("Zm9v"));
        assertTypeMismatch(() -> Base64Policy.validateAndGetDecodedLength("Zg=\n"));
        assertTypeMismatch(() -> Base64Policy.validateAndGetDecodedLength("Zh=="));
        assertTypeMismatch(() -> Base64Policy.validateAndGetDecodedLength("Zm9"));
    }

    private static void testMimeTypes() throws Exception {
        assertEquals("image/*", MimePolicy.validate("image/*", true));
        assertTypeMismatch(() -> MimePolicy.validate("image/*", false));
        assertTypeMismatch(() -> MimePolicy.validate("image/p*ng", true));
    }

    private static void testSearchParsers() {
        String bing =
            "<?xml version='1.0'?><rss version='2.0'><channel><item>" +
            "<title>A Title</title><link>https://example.com/a?x=1&amp;y=2</link>" +
            "<description>A &amp; B</description></item></channel></rss>";
        List<SearchParser.Result> bingResults = SearchParser.parse("bing", bing, 5);
        assertEquals(1, bingResults.size());
        assertEquals("A Title", bingResults.get(0).title);
        assertEquals("https://example.com/a?x=1&y=2", bingResults.get(0).url);

        String duck =
            "<div class='result web-result'><a class='result__a' " +
            "href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdoc&amp;rut=x'>Doc</a>" +
            "<a class='result__snippet'>Safe <b>text</b></a></div>";
        List<SearchParser.Result> duckResults = SearchParser.parse("duckduckgo", duck, 5);
        assertEquals(1, duckResults.size());
        assertEquals("https://example.org/doc", duckResults.get(0).url);

        String mojeek =
            "<!--rs--><li><h2><a href='https://example.net/'>Result</a></h2>" +
            "<p class='s'>Snippet</p></li><!--re-->";
        assertEquals(1, SearchParser.parse("mojeek", mojeek, 1).size());

        String unsafe = bingRssItem("https://localhost/");
        assertEquals(0, SearchParser.parse("bing", unsafe, 5).size());
        String numeric = bingRssItem("https://2130706433/");
        assertEquals(0, SearchParser.parse("bing", numeric, 5).size());
        String hexNumeric = bingRssItem("https://0x7f000001/");
        assertEquals(0, SearchParser.parse("bing", hexNumeric, 5).size());

        String activeXml =
            "<!DOCTYPE rss [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]>" +
            "<rss><channel><item><title>&xxe;</title><link>https://example.com/</link></item></channel></rss>";
        assertEquals(0, SearchParser.parse("bing", activeXml, 5).size());
    }

    private static String bingRssItem(String url) {
        return "<rss><channel><item><title>Local</title><link>" + url +
            "</link><description>x</description></item></channel></rss>";
    }

    private static void assertBadPath(String value) {
        try {
            PathPolicy.normalize(value, false);
            throw new AssertionError("Expected BAD_PATH: " + value);
        } catch (KnoteException exception) {
            assertEquals(ErrorCodes.BAD_PATH, exception.getCode());
        }
    }

    private static void assertTypeMismatch(CheckedRunnable operation) {
        try {
            operation.run();
            throw new AssertionError("Expected TYPE_MISMATCH");
        } catch (KnoteException exception) {
            assertEquals(ErrorCodes.TYPE_MISMATCH, exception.getCode());
        } catch (Exception exception) {
            throw new AssertionError(exception);
        }
    }

    private static void assertEquals(Object expected, Object actual) {
        if (!expected.equals(actual)) {
            throw new AssertionError("Expected " + expected + " but got " + actual);
        }
    }

    private interface CheckedRunnable {
        void run() throws Exception;
    }
}
