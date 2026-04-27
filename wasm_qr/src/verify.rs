use base64::Engine as _;
use base64::engine::general_purpose::{self, GeneralPurpose};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::collections::HashSet;
use url::Url;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestCache, RequestInit, RequestRedirect, Response, Window};

const MAX_HTML_SCAN_BYTES: usize = 1_500_000;
const DIRECT_SHORT_RESOLVE_MAX_STEPS: usize = 8;
const TARGET_PARAM_KEYS: [&str; 13] = [
    "url",
    "target",
    "dest",
    "destination",
    "redirect",
    "redirect_url",
    "redirect_uri",
    "next",
    "continue",
    "to",
    "u",
    "r",
    "out",
];
const KNOWN_SHORTENER_HOST_SUFFIXES: [&str; 54] = [
    "adf.ly",
    "bl.ink",
    "bit.do",
    "bit.ly",
    "buff.ly",
    "chilp.it",
    "clck.ru",
    "clk.im",
    "cutt.ly",
    "cutt.us",
    "dub.co",
    "goo.gl",
    "is.gd",
    "ity.im",
    "j.mp",
    "lc.chat",
    "linklyhq.com",
    "lnkd.in",
    "lnk.to",
    "mcaf.ee",
    "ow.ly",
    "po.st",
    "qrco.de",
    "rb.gy",
    "rebrand.ly",
    "s.id",
    "short.io",
    "short.cm",
    "short.gy",
    "shorturl.asia",
    "shorte.st",
    "shrlc.com",
    "shorturl.at",
    "smarturl.it",
    "soo.gd",
    "surl.li",
    "tiny.ie",
    "tinyurl.is",
    "t.co",
    "t.ly",
    "t2m.io",
    "tiny.cc",
    "tiny.one",
    "tiny.pl",
    "tinyurl.com",
    "tr.im",
    "trib.al",
    "u.nu",
    "u.to",
    "v.gd",
    "x.co",
    "x.gd",
    "yourls.org",
    "zpr.io",
];
const KNOWN_INTERSTITIAL_HOST_SUFFIXES: [&str; 16] = [
    "adfoc.us",
    "adf.ly",
    "bc.vc",
    "cety.app",
    "cpmlink.net",
    "droplink.co",
    "exe.io",
    "gplinks.co",
    "linkvertise.com",
    "lootdest.org",
    "me-qr.com",
    "ouo.io",
    "ouo.press",
    "rekonise.com",
    "shorte.st",
    "sub2get.com",
];

#[derive(Debug, Clone, Serialize)]
struct WasmVerifiedLink {
    input_link: String,
    resolved_link: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VerifyLinkErrorKind {
    InvalidLink,
    ServiceUnavailable,
    CannotResolve,
}

#[derive(Debug, Clone)]
struct VerifyLinkError {
    kind: VerifyLinkErrorKind,
    detail: String,
}

impl VerifyLinkError {
    fn new(kind: VerifyLinkErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    fn to_js_error(&self) -> JsValue {
        JsValue::from_str(&format!("{}: {}", self.kind.as_str(), self.detail))
    }
}

impl VerifyLinkErrorKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidLink => "invalid-link",
            Self::ServiceUnavailable => "service-unavailable",
            Self::CannotResolve => "cannot-resolve",
        }
    }
}

#[derive(Debug)]
struct FetchSnapshot {
    final_url: String,
    status: u16,
    body: String,
}

#[wasm_bindgen]
pub async fn verify_link_wasm(input: String) -> Result<JsValue, JsValue> {
    let verified = verify_link_internal(&input)
        .await
        .map_err(|error| error.to_js_error())?;

    serde_wasm_bindgen::to_value(&verified)
        .map_err(|error| js_error(&format!("Cannot serialize verify result: {error}")))
}

async fn verify_link_internal(input: &str) -> Result<WasmVerifiedLink, VerifyLinkError> {
    let input_link = normalize_user_input_link(input)?;
    let mut resolved_link = unwrap_embedded_targets(input_link.clone());
    let shortener_domains = shortener_domain_set();
    let mut resolved_from_shortener = false;

    if let Some(direct_link) = resolve_short_link_directly(&resolved_link, &shortener_domains).await {
        resolved_link = unwrap_embedded_targets(direct_link);
        resolved_from_shortener = true;
    }

    if resolved_from_shortener {
        if let Ok(url) = Url::parse(&resolved_link) {
            if !should_bypass_after_shortener_resolution(&url, &shortener_domains) {
                return Ok(WasmVerifiedLink {
                    input_link,
                    resolved_link,
                });
            }
        }
    }

    match resolve_with_http(&resolved_link).await {
        Ok(link) => {
            resolved_link = unwrap_embedded_targets(link);
        }
        Err(error) => {
            if resolved_link == input_link {
                return Err(error);
            }
        }
    }

    Ok(WasmVerifiedLink {
        input_link,
        resolved_link,
    })
}

fn shortener_domain_set() -> HashSet<String> {
    KNOWN_SHORTENER_HOST_SUFFIXES
        .iter()
        .map(|suffix| (*suffix).to_string())
        .collect()
}

async fn resolve_short_link_directly(
    start_link: &str,
    shortener_domains: &HashSet<String>,
) -> Option<String> {
    let mut current = Url::parse(start_link).ok()?;
    let mut changed = false;

    for _ in 0..DIRECT_SHORT_RESOLVE_MAX_STEPS {
        let host = current.host_str()?.to_ascii_lowercase();
        if !is_known_shortener_host(&host, shortener_domains) {
            break;
        }

        let next = if let Some(public_link) = resolve_short_link_via_public_api(&current).await {
            Some(public_link)
        } else {
            resolve_short_link_via_fetch_follow(&current).await
        };
        let Some(next_link) = next else {
            break;
        };

        if next_link.eq_ignore_ascii_case(current.as_str()) {
            break;
        }

        let Ok(next_url) = Url::parse(&next_link) else {
            break;
        };

        changed = true;
        current = next_url;
    }

    changed.then(|| current.to_string())
}

async fn resolve_short_link_via_public_api(short_url: &Url) -> Option<String> {
    let host = short_url.host_str()?.to_ascii_lowercase();

    if !(host_matches_suffix(&host, "is.gd") || host_matches_suffix(&host, "v.gd")) {
        return None;
    }

    let mut api_url = Url::parse(&format!("https://{host}/forward.php")).ok()?;
    api_url
        .query_pairs_mut()
        .append_pair("format", "simple")
        .append_pair("shorturl", short_url.as_str());

    let snapshot = fetch_text_follow(api_url.as_str()).await.ok()?;
    if !is_success_status(snapshot.status) {
        return None;
    }

    parse_simple_shortener_api_response(short_url, &snapshot.body)
}

async fn resolve_short_link_via_fetch_follow(short_url: &Url) -> Option<String> {
    let final_url = fetch_final_url_follow(short_url.as_str(), &[("Range", "bytes=0-0")])
        .await
        .ok()?;

    if final_url.eq_ignore_ascii_case(short_url.as_str()) {
        return None;
    }

    normalize_location_header_target(short_url, &final_url)
}

fn normalize_location_header_target(base_url: &Url, location: &str) -> Option<String> {
    let cleaned = clean_candidate_value(location);
    if cleaned.is_empty() {
        return None;
    }

    if let Some(link) = normalize_candidate_link(&cleaned, Some(base_url)) {
        return Some(link);
    }

    let decoded = percent_decode_str(&cleaned).decode_utf8_lossy().to_string();
    if decoded != cleaned {
        return normalize_candidate_link(&decoded, Some(base_url));
    }

    None
}

fn parse_simple_shortener_api_response(base_url: &Url, body: &str) -> Option<String> {
    let first_line = body.lines().next()?.trim();
    if first_line.is_empty() || first_line.to_ascii_lowercase().starts_with("error:") {
        return None;
    }

    normalize_candidate_link(first_line, Some(base_url))
}

fn is_known_shortener_host(host: &str, shortener_domains: &HashSet<String>) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }

    shortener_domains
        .iter()
        .any(|suffix| host_matches_suffix(&host, suffix))
}

fn should_bypass_after_shortener_resolution(
    resolved_url: &Url,
    shortener_domains: &HashSet<String>,
) -> bool {
    let Some(host) = resolved_url.host_str() else {
        return true;
    };

    if is_known_shortener_host(host, shortener_domains) {
        return true;
    }

    if KNOWN_INTERSTITIAL_HOST_SUFFIXES
        .iter()
        .any(|suffix| host_matches_suffix(host, suffix))
    {
        return true;
    }

    if extract_embedded_target_from_url(resolved_url).is_some() {
        return true;
    }

    looks_like_interstitial_path_or_query(resolved_url)
}

fn looks_like_interstitial_path_or_query(url: &Url) -> bool {
    let path = url.path().to_ascii_lowercase();
    let query = url.query().unwrap_or_default().to_ascii_lowercase();

    let path_markers = [
        "/redirect",
        "/out",
        "/away",
        "/goto",
        "/go/",
        "/skip",
        "/visit",
        "/ads",
    ];

    if path_markers.iter().any(|marker| path.contains(marker)) {
        return true;
    }

    TARGET_PARAM_KEYS
        .iter()
        .any(|key| query.contains(&format!("{key}=")))
}

fn host_matches_suffix(host: &str, suffix: &str) -> bool {
    host.eq_ignore_ascii_case(suffix)
        || host
            .to_ascii_lowercase()
            .ends_with(&format!(".{}", suffix.to_ascii_lowercase()))
}

async fn resolve_with_http(start_link: &str) -> Result<String, VerifyLinkError> {
    let snapshot = fetch_text_follow(start_link).await?;

    let final_url = Url::parse(&snapshot.final_url).map_err(|error| {
        VerifyLinkError::new(
            VerifyLinkErrorKind::CannotResolve,
            format!("Cannot parse resolved URL: {error}"),
        )
    })?;

    let final_url_text = final_url.to_string();

    if let Some(target) = extract_embedded_target_from_url(&final_url) {
        return Ok(target);
    }

    if let Some(target) = extract_target_from_html(&snapshot.body, &final_url) {
        return Ok(target);
    }

    Ok(final_url_text)
}

async fn fetch_text_follow(url: &str) -> Result<FetchSnapshot, VerifyLinkError> {
    let response = fetch_response(url, "GET", &[]).await?;
    let final_url = response.url();
    let status = response.status();

    let text_promise = response.text().map_err(|error| {
        VerifyLinkError::new(
            VerifyLinkErrorKind::CannotResolve,
            format!("Cannot read response body: {}", js_value_to_string(&error)),
        )
    })?;
    let text_js = JsFuture::from(text_promise)
        .await
        .map_err(|error| map_fetch_error(error, VerifyLinkErrorKind::CannotResolve))?;

    let body = text_js.as_string().unwrap_or_default();

    Ok(FetchSnapshot {
        final_url,
        status,
        body,
    })
}

async fn fetch_final_url_follow(
    url: &str,
    headers: &[(&str, &str)],
) -> Result<String, VerifyLinkError> {
    let response = fetch_response(url, "GET", headers).await?;
    Ok(response.url())
}

async fn fetch_response(
    url: &str,
    method: &str,
    headers: &[(&str, &str)],
) -> Result<Response, VerifyLinkError> {
    let init = RequestInit::new();
    init.set_method(method);
    init.set_cache(RequestCache::NoStore);
    init.set_redirect(RequestRedirect::Follow);

    let request = Request::new_with_str_and_init(url, &init).map_err(|error| {
        VerifyLinkError::new(
            VerifyLinkErrorKind::CannotResolve,
            format!("Cannot create request: {}", js_value_to_string(&error)),
        )
    })?;

    for (name, value) in headers {
        request.headers().set(name, value).map_err(|error| {
            VerifyLinkError::new(
                VerifyLinkErrorKind::CannotResolve,
                format!("Cannot set request header '{name}': {}", js_value_to_string(&error)),
            )
        })?;
    }

    let window = browser_window()?;
    let response_value = JsFuture::from(window.fetch_with_request(&request))
        .await
        .map_err(|error| map_fetch_error(error, VerifyLinkErrorKind::ServiceUnavailable))?;

    response_value.dyn_into::<Response>().map_err(|error| {
        VerifyLinkError::new(
            VerifyLinkErrorKind::CannotResolve,
            format!("Cannot cast fetch response: {}", js_value_to_string(&error)),
        )
    })
}

fn browser_window() -> Result<Window, VerifyLinkError> {
    web_sys::window().ok_or_else(|| {
        VerifyLinkError::new(
            VerifyLinkErrorKind::ServiceUnavailable,
            "Browser window is unavailable",
        )
    })
}

fn map_fetch_error(js_error: JsValue, fallback_kind: VerifyLinkErrorKind) -> VerifyLinkError {
    let detail = js_value_to_string(&js_error);
    let detail_lower = detail.to_ascii_lowercase();

    if detail_lower.contains("networkerror")
        || detail_lower.contains("failed to fetch")
        || detail_lower.contains("load failed")
    {
        return VerifyLinkError::new(VerifyLinkErrorKind::ServiceUnavailable, detail);
    }

    VerifyLinkError::new(fallback_kind, detail)
}

fn js_value_to_string(value: &JsValue) -> String {
    value
        .as_string()
        .unwrap_or_else(|| format!("{value:?}"))
}

fn is_success_status(status: u16) -> bool {
    (200..300).contains(&status)
}

fn normalize_user_input_link(input: &str) -> Result<String, VerifyLinkError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(VerifyLinkError::new(
            VerifyLinkErrorKind::InvalidLink,
            "Input link is empty",
        ));
    }

    if let Some(normalized) = normalize_candidate_link(trimmed, None) {
        return Ok(normalized);
    }

    let candidate = format!("https://{trimmed}");
    normalize_candidate_link(&candidate, None).ok_or_else(|| {
        VerifyLinkError::new(
            VerifyLinkErrorKind::InvalidLink,
            "Input link format is invalid",
        )
    })
}

fn unwrap_embedded_targets(start_link: String) -> String {
    let mut current = start_link;

    for _ in 0..8 {
        let Some(url) = Url::parse(&current).ok() else {
            break;
        };

        let Some(next) = extract_embedded_target_from_url(&url) else {
            break;
        };

        if next == current {
            break;
        }

        current = next;
    }

    current
}

fn extract_embedded_target_from_url(url: &Url) -> Option<String> {
    for (key, value) in url.query_pairs() {
        if TARGET_PARAM_KEYS
            .iter()
            .any(|candidate| key.eq_ignore_ascii_case(candidate))
        {
            if let Some(target) = decode_candidate_link(value.as_ref(), Some(url)) {
                return Some(target);
            }
        }
    }

    if let Some(fragment) = url.fragment() {
        if let Some(target) = decode_candidate_link(fragment, Some(url)) {
            return Some(target);
        }

        for (key, value) in url::form_urlencoded::parse(fragment.as_bytes()) {
            if TARGET_PARAM_KEYS
                .iter()
                .any(|candidate| key.eq_ignore_ascii_case(candidate))
            {
                if let Some(target) = decode_candidate_link(value.as_ref(), Some(url)) {
                    return Some(target);
                }
            }
        }
    }

    None
}

fn decode_candidate_link(raw: &str, base_url: Option<&Url>) -> Option<String> {
    let cleaned = clean_candidate_value(raw);
    if cleaned.is_empty() {
        return None;
    }

    if let Some(candidate) = normalize_candidate_link(&cleaned, base_url) {
        return Some(candidate);
    }

    let decoded_percent = percent_decode_str(&cleaned).decode_utf8_lossy().to_string();
    if decoded_percent != cleaned {
        if let Some(candidate) = normalize_candidate_link(&decoded_percent, base_url) {
            return Some(candidate);
        }
    }

    for decoded in decode_base64_candidates(&cleaned) {
        if let Some(candidate) = normalize_candidate_link(&decoded, base_url) {
            return Some(candidate);
        }
    }

    None
}

fn decode_base64_candidates(raw: &str) -> Vec<String> {
    let mut decoded_values = Vec::new();
    for engine in [
        &general_purpose::STANDARD,
        &general_purpose::URL_SAFE,
        &general_purpose::STANDARD_NO_PAD,
        &general_purpose::URL_SAFE_NO_PAD,
    ] {
        if let Some(decoded) = decode_base64_once(raw, engine) {
            if !decoded_values.iter().any(|value| value == &decoded) {
                decoded_values.push(decoded);
            }
        }
    }

    decoded_values
}

fn decode_base64_once(raw: &str, engine: &GeneralPurpose) -> Option<String> {
    let normalized = clean_candidate_value(raw);
    if normalized.len() < 8 {
        return None;
    }

    let bytes = engine.decode(normalized.as_bytes()).ok()?;
    String::from_utf8(bytes).ok()
}

fn clean_candidate_value(raw: &str) -> String {
    raw.trim()
        .trim_matches('"')
        .trim_matches('\'')
        .replace("&amp;", "&")
}

fn normalize_candidate_link(candidate: &str, base_url: Option<&Url>) -> Option<String> {
    let cleaned = clean_candidate_value(candidate);
    if cleaned.is_empty() {
        return None;
    }

    if let Ok(url) = Url::parse(&cleaned) {
        if is_supported_scheme(&url) {
            return Some(url.to_string());
        }
        return None;
    }

    if cleaned.starts_with("//") {
        let scheme = base_url.map(|url| url.scheme()).unwrap_or("https");
        let fallback = format!("{scheme}:{cleaned}");
        if let Ok(url) = Url::parse(&fallback) {
            if is_supported_scheme(&url) {
                return Some(url.to_string());
            }
        }
    }

    if let Some(base_url) = base_url {
        if let Ok(url) = base_url.join(&cleaned) {
            if is_supported_scheme(&url) {
                return Some(url.to_string());
            }
        }
    }

    None
}

fn is_supported_scheme(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn extract_target_from_html(html: &str, base_url: &Url) -> Option<String> {
    let scan_text = truncate_for_scan(html, MAX_HTML_SCAN_BYTES);

    extract_meta_refresh_target(scan_text, base_url)
        .or_else(|| extract_javascript_redirect_target(scan_text, base_url))
        .or_else(|| extract_anchor_skip_target(scan_text, base_url))
        .or_else(|| extract_canonical_target(scan_text, base_url))
}

fn truncate_for_scan(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }

    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }

    &text[..end]
}

fn extract_meta_refresh_target(html: &str, base_url: &Url) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find("<meta") {
        let start = cursor + relative_start;
        let end = lower[start..]
            .find('>')
            .map(|offset| start + offset + 1)
            .unwrap_or(lower.len());

        let tag = &html[start..end];
        let tag_lower = tag.to_ascii_lowercase();
        cursor = end;

        if !tag_lower.contains("refresh") {
            continue;
        }

        let Some(content) = extract_tag_attr(tag, "content") else {
            continue;
        };
        let content_lower = content.to_ascii_lowercase();
        let Some(url_pos) = content_lower.find("url=") else {
            continue;
        };

        let candidate = clean_candidate_value(&content[url_pos + 4..]);
        if let Some(target) = decode_candidate_link(&candidate, Some(base_url)) {
            return Some(target);
        }
    }

    None
}

fn extract_canonical_target(html: &str, base_url: &Url) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find("<link") {
        let start = cursor + relative_start;
        let end = lower[start..]
            .find('>')
            .map(|offset| start + offset + 1)
            .unwrap_or(lower.len());

        let tag = &html[start..end];
        let tag_lower = tag.to_ascii_lowercase();
        cursor = end;

        if !tag_lower.contains("canonical") {
            continue;
        }

        let Some(href) = extract_tag_attr(tag, "href") else {
            continue;
        };
        let Some(target) = decode_candidate_link(&href, Some(base_url)) else {
            continue;
        };

        let Some(target_url) = Url::parse(&target).ok() else {
            continue;
        };

        if hosts_are_related(base_url, &target_url) {
            continue;
        }

        return Some(target);
    }

    None
}

fn extract_anchor_skip_target(html: &str, base_url: &Url) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find("<a") {
        let start = cursor + relative_start;
        let open_end = lower[start..]
            .find('>')
            .map(|offset| start + offset + 1)
            .unwrap_or(lower.len());
        let close_end = lower[open_end..]
            .find("</a>")
            .map(|offset| open_end + offset + 4)
            .unwrap_or(open_end);

        let tag = &html[start..open_end];
        let anchor_text = if close_end > open_end {
            &html[open_end..close_end]
        } else {
            ""
        };
        cursor = close_end.max(open_end);

        let Some(href) = extract_tag_attr(tag, "href") else {
            continue;
        };

        let Some(target) = decode_candidate_link(&href, Some(base_url)) else {
            continue;
        };

        let Some(target_url) = Url::parse(&target).ok() else {
            continue;
        };

        if hosts_are_related(base_url, &target_url) {
            continue;
        }

        let combined = format!(
            "{} {}",
            tag.to_ascii_lowercase(),
            anchor_text.to_ascii_lowercase()
        );
        if combined.contains("skip")
            || combined.contains("unlock")
            || combined.contains("continue")
            || combined.contains("go to")
            || combined.contains("open")
            || combined.contains("watch one short ad")
        {
            return Some(target);
        }
    }

    None
}

fn hosts_are_related(left: &Url, right: &Url) -> bool {
    let Some(left_host) = left.host_str() else {
        return false;
    };
    let Some(right_host) = right.host_str() else {
        return false;
    };

    hosts_share_suffix(left_host, right_host)
}

fn hosts_share_suffix(left: &str, right: &str) -> bool {
    if left.eq_ignore_ascii_case(right) {
        return true;
    }

    let left_lower = left.to_ascii_lowercase();
    let right_lower = right.to_ascii_lowercase();

    left_lower.ends_with(&format!(".{right_lower}"))
        || right_lower.ends_with(&format!(".{left_lower}"))
}

fn extract_javascript_redirect_target(html: &str, base_url: &Url) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let patterns = [
        "window.location.href",
        "window.location",
        "top.location.href",
        "location.href",
        "location.replace",
    ];

    for pattern in patterns {
        let mut cursor = 0;
        while let Some(relative_start) = lower[cursor..].find(pattern) {
            let start = cursor + relative_start;
            let look_ahead_end = (start + 600).min(html.len());
            let window = &html[start..look_ahead_end];
            cursor = start + pattern.len();

            if let Some(quoted) = extract_first_quoted_value(window) {
                if let Some(target) = decode_candidate_link(&quoted, Some(base_url)) {
                    return Some(target);
                }
            }
        }
    }

    None
}

fn extract_tag_attr(tag: &str, attr_name: &str) -> Option<String> {
    let tag_lower = tag.to_ascii_lowercase();
    let needle = format!("{attr_name}=");
    let start = tag_lower.find(&needle)? + needle.len();
    let rest = &tag[start..];

    let mut chars = rest.char_indices();
    let (_, first_char) = chars.next()?;

    if first_char == '"' || first_char == '\'' {
        let quote = first_char;
        let content_start = first_char.len_utf8();
        let content = &rest[content_start..];
        let end = content.find(quote)?;
        return Some(content[..end].to_string());
    }

    let end = rest
        .find(|ch: char| ch.is_whitespace() || ch == '>')
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

fn extract_first_quoted_value(text: &str) -> Option<String> {
    let start = text.find(|ch: char| ch == '"' || ch == '\'')?;
    let quote = text[start..].chars().next()?;
    let content_start = start + quote.len_utf8();
    let content = &text[content_start..];
    let end = content.find(quote)?;

    Some(content[..end].to_string())
}

fn js_error(message: &str) -> JsValue {
    JsValue::from_str(message)
}
