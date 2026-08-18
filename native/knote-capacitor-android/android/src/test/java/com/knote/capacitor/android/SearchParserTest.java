package com.knote.capacitor.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

public class SearchParserTest {
    @Test
    public void parsesBingResultsConservatively() {
        String rss =
            "<?xml version='1.0' encoding='UTF-8'?><rss version='2.0'><channel>" +
            "<title>Bing: test</title><link>https://www.bing.com/search?q=test</link>" +
            "<description>Search results</description><image>" +
            "<url>https://www.bing.com/s/a/rsslogo.gif</url><title>Bing</title>" +
            "<link>https://www.bing.com/search?q=test</link></image><copyright>Microsoft</copyright><item>" +
            "<title>A Title</title><link>https://example.com/a?x=1&amp;y=2</link>" +
            "<description>A &amp; B snippet</description><pubDate>Fri, 14 Aug 2026 00:00:00 GMT</pubDate>" +
            "</item></channel></rss>";
        SearchParser.ParseOutcome outcome = SearchParser.parseResponse("bing", rss, 5);
        assertTrue(outcome.valid);
        List<SearchParser.Result> results = outcome.results;
        assertEquals(1, results.size());
        assertEquals("A Title", results.get(0).title);
        assertEquals("https://example.com/a?x=1&y=2", results.get(0).url);
        assertEquals("A & B snippet", results.get(0).snippet);
    }

    @Test
    public void stripsBingDescriptionMarkupAndHonorsMaximum() {
        String item =
            "<item><title>Result</title><link>https://example.com/</link>" +
            "<description><![CDATA[Safe <b>text</b>]]></description></item>";
        List<SearchParser.Result> results = SearchParser.parse(
            "bing",
            "<rss version='2.0'><channel>" + item + item + "</channel></rss>",
            1
        );
        assertEquals(1, results.size());
        assertEquals("Safe text", results.get(0).snippet);
    }

    @Test
    public void rejectsMalformedOrActiveBingXml() {
        String doctype =
            "<!DOCTYPE rss [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]>" +
            "<rss><channel><item><title>&xxe;</title><link>https://example.com/</link></item></channel></rss>";
        String malformed =
            "<rss><channel><item><title>Title</title><link>https://example.com/</link></channel></rss>";
        assertFalse(SearchParser.parseResponse("bing", doctype, 5).valid);
        assertFalse(SearchParser.parseResponse("bing", malformed, 5).valid);
    }

    @Test
    public void acceptsStructurallyValidEmptyBingRss() {
        SearchParser.ParseOutcome outcome = SearchParser.parseResponse(
            "bing",
            "<?xml version='1.0'?><rss version='2.0'><channel><title>No matches</title></channel></rss>",
            5
        );
        assertTrue(outcome.valid);
        assertFalse(outcome.blocked);
        assertTrue(outcome.results.isEmpty());
    }

    @Test
    public void parsesDuckDuckGoRedirectTargetsAndSkipsAds() {
        String html =
            "<div class='result result--ad'><a class='result__a' href='https://ad.example/'>Ad</a></div>" +
            "<div class='result web-result'><h2><a class='result__a' " +
            "href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdoc&amp;rut=x'>Doc</a></h2>" +
            "<a class='result__snippet'>Safe <b>text</b></a></div>";
        List<SearchParser.Result> results = SearchParser.parse("duckduckgo", html, 5);
        assertEquals(1, results.size());
        assertEquals("https://example.org/doc", results.get(0).url);
        assertEquals("Safe text", results.get(0).snippet);
    }

    @Test
    public void parsesMojeekMarkersAndHonorsMaximum() {
        String block =
            "<!--rs--><li><h2><a class='title' href='https://example.net/'>Result</a></h2>" +
            "<p class='s'>Snippet</p></li><!--re-->";
        List<SearchParser.Result> results = SearchParser.parse("mojeek", block + block, 1);
        assertEquals(1, results.size());
        assertEquals("Result", results.get(0).title);
    }

    @Test
    public void distinguishesExplicitEmptyPagesFromBlockedAndUnparseablePages() {
        SearchParser.ParseOutcome duckEmpty = SearchParser.parseResponse(
            "duckduckgo",
            "<!doctype html><html><head><title>DuckDuckGo</title></head><body><div class='no-results'>No results found</div></body></html>",
            5
        );
        SearchParser.ParseOutcome mojeekEmpty = SearchParser.parseResponse(
            "mojeek",
            "<!doctype html><html><head><title>Mojeek</title></head><body><p class='no-results'>No web results found</p></body></html>",
            5
        );
        SearchParser.ParseOutcome blocked = SearchParser.parseResponse(
            "duckduckgo",
            "<html><head><title>Attention Required</title></head><body><form id='captcha'>Verify that you are human</form></body></html>",
            5
        );
        SearchParser.ParseOutcome unknown = SearchParser.parseResponse(
            "mojeek",
            "<html><head><title>Landing page</title></head><body>Try our products</body></html>",
            5
        );

        assertTrue(duckEmpty.valid);
        assertTrue(duckEmpty.results.isEmpty());
        assertTrue(mojeekEmpty.valid);
        assertTrue(mojeekEmpty.results.isEmpty());
        assertTrue(blocked.blocked);
        assertFalse(blocked.valid);
        assertFalse(unknown.valid);
        assertFalse(unknown.blocked);
    }

    @Test
    public void rejectsUnsafeResultUrls() {
        String rss =
            "<rss><channel>" +
            item("javascript:alert(1)") +
            item("https://user@example.com/") +
            item("https://example.com:444/") +
            item("https://127.0.0.1/#fragment") +
            item("https://localhost/") +
            item("https://2130706433/") +
            item("https://0x7f000001/") +
            "</channel></rss>";
        assertEquals(0, SearchParser.parse("bing", rss, 10).size());
    }

    @Test
    public void rejectsHttpResultUrlsAcrossAllParsers() {
        String bing = "<rss><channel>" + item("http://example.com/bing") + "</channel></rss>";
        String duck =
            "<div class='result web-result'><a class='result__a' " +
            "href='//duckduckgo.com/l/?uddg=http%3A%2F%2Fexample.com%2Fduck'>Duck</a>" +
            "<a class='result__snippet'>Snippet</a></div>";
        String mojeek =
            "<!--rs--><li><h2><a href='http://example.com/mojeek'>Mojeek</a></h2>" +
            "<p class='s'>Snippet</p></li><!--re-->";

        assertEquals(0, SearchParser.parse("bing", bing, 5).size());
        assertEquals(0, SearchParser.parse("duckduckgo", duck, 5).size());
        assertEquals(0, SearchParser.parse("mojeek", mojeek, 5).size());
    }

    private static String item(String url) {
        return "<item><title>Unsafe</title><link>" + url + "</link><description>x</description></item>";
    }
}
