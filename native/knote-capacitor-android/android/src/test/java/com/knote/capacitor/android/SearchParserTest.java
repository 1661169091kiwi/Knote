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

    private static String item(String url) {
        return "<item><title>Unsafe</title><link>" + url + "</link><description>x</description></item>";
    }
}
