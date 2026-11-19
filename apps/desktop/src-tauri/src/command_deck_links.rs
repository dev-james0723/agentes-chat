//! Read-only navigation contracts for an external command deck. No server is added,
//! no credentials are accepted, and loopback content never gains app IPC access.

use std::collections::HashSet;

use tauri::Url;

pub const PANEL_ORIGIN: &str = "http://127.0.0.1:17374";
const MAX_LINK: usize = 2048;
const MAX_TARGET: usize = 4096;
// encodeURIComponent may triple the target's bytes; setup/pair/panel keep 2048.
pub const MAX_NAVIGATION_LINK: usize = 3 * MAX_TARGET + 128;

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
        && matches!(value.as_bytes()[14], b'1'..=b'8')
        && matches!(
            value.as_bytes()[19].to_ascii_lowercase(),
            b'8' | b'9' | b'a' | b'b'
        )
}

fn field(url: &Url, host: &str, name: &str) -> Option<String> {
    let limit = if host == "navigate" { MAX_NAVIGATION_LINK } else { MAX_LINK };
    if url.scheme() != "agenteschat"
        || url.host_str() != Some(host)
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > limit
    {
        return None;
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    (pairs.len() == 1 && pairs[0].0 == name).then(|| pairs[0].1.to_string())
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// Better Auth person IDs are opaque, not UUIDs. Mirror the bridge's one canonical
// encodeURIComponent segment; reject separators, controls and double decoding.
fn person_segment(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let Some((a, b)) = bytes
                .get(at + 1)
                .and_then(|a| hex(*a))
                .zip(bytes.get(at + 2).and_then(|b| hex(*b)))
            else {
                return false;
            };
            decoded.push(a * 16 + b);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    let Ok(value) = String::from_utf8(decoded) else {
        return false;
    };
    if value.is_empty()
        || value.encode_utf16().count() > 160
        || matches!(value.as_str(), "." | "..")
        || value
            .chars()
            .any(|c| c <= '\u{20}' || c == '\u{7f}' || matches!(c, '/' | '\\' | '?' | '#' | '%'))
    {
        return false;
    }
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded == raw
}

/// Only navigation surfaces already offered by the deck. Query values remain in
/// the original URL, including message/thread anchors; no pathname-only rewrite.
pub fn configured_target(raw: &str, servers: &[String]) -> Option<Url> {
    if raw.len() > MAX_TARGET || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.as_str() != raw
        || !servers.contains(&url.origin().ascii_serialization())
    {
        return None;
    }
    let path = url.path().strip_suffix('/').unwrap_or(url.path());
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() < 4 || parts[0] != "" || parts[1] != "org" || !uuid(parts[2]) {
        return None;
    }
    let destination = &parts[3..];
    let allowed = match destination {
        [page] => matches!(
            *page,
            "home"
                | "team"
                | "waiting"
                | "notifications"
                | "task-manager"
                | "issues"
                | "search"
                | "calendar"
                | "approvals"
                | "routines"
                | "drive"
                | "skills"
        ),
        ["settings", section] => matches!(
            *section,
            "account" | "workspace" | "ai" | "devices" | "connectors"
        ),
        ["c" | "threads", id] | ["dm", "agent", id] => uuid(id),
        ["dm", "person", id] => person_segment(id),
        ["issues", number] => {
            !number.is_empty() && number.len() <= 16 && number.bytes().all(|c| c.is_ascii_digit())
        }
        _ => false,
    };
    if !allowed {
        return None;
    }
    let mut seen = HashSet::new();
    for (key, value) in url.query_pairs() {
        if !seen.insert(key.to_string()) || !uuid(&value) {
            return None;
        }
        let applies = match key.as_ref() {
            "m" => matches!(
                destination,
                ["c" | "threads" | "issues", _] | ["dm", "agent" | "person", _]
            ),
            "thread" => matches!(destination, ["c", _] | ["dm", "agent" | "person", _]),
            "open" => matches!(destination, ["approvals"] | ["notifications"]),
            _ => false,
        };
        if !applies {
            return None;
        }
    }
    Some(url)
}

pub fn navigation_link(url: &Url, servers: &[String]) -> Option<Url> {
    configured_target(&field(url, "navigate", "url")?, servers)
}

fn valid_ticket(ticket: &str) -> bool {
    (16..=256).contains(&ticket.len())
        && ticket
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub fn panel_link(url: &Url) -> Option<Url> {
    let ticket = field(url, "command-deck", "ticket")?;
    if !valid_ticket(&ticket) {
        return None;
    }
    let mut launch = Url::parse(&format!("{PANEL_ORIGIN}/launch")).ok()?;
    launch.query_pairs_mut().append_pair("ticket", &ticket);
    Some(launch)
}

/// Top-level navigation in the isolated panel. Assets and /panel/action fetches
/// use the page's own CSP, not a Tauri capability. No other host or port is allowed.
pub fn panel_page(url: &Url) -> bool {
    if url.origin().ascii_serialization() != PANEL_ORIGIN
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match url.path() {
        "/panel" => url.query().is_none(),
        "/launch" => {
            let pairs: Vec<_> = url.query_pairs().collect();
            pairs.len() == 1 && pairs[0].0 == "ticket" && valid_ticket(&pairs[0].1)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://example.tail1234.ts.net:8445";
    const ORG: &str = "b221b439-4343-459b-bd26-f2abd0dfe764";
    const AGENT: &str = "2ef0ee34-e137-4fcb-9c12-6d5d20d34f56";
    const MESSAGE: &str = "77d93b39-0f13-4b2c-9d17-abe6a5ebd50f";
    fn servers() -> Vec<String> {
        vec![SERVER.to_string()]
    }
    fn target(path: &str) -> String {
        format!("{SERVER}/org/{ORG}/{path}")
    }
    fn link(target: &str) -> Url {
        let mut url = Url::parse("agenteschat://navigate").unwrap();
        url.query_pairs_mut().append_pair("url", target);
        url
    }

    #[test]
    fn keeps_exact_message_and_thread_query_in_known_server() {
        let raw = target(&format!("c/{AGENT}?thread={AGENT}&m={MESSAGE}"));
        assert_eq!(
            navigation_link(&link(&raw), &servers()).unwrap().as_str(),
            raw
        );
        for path in [
            format!("dm/agent/{AGENT}?m={MESSAGE}"),
            format!("threads/{AGENT}?m={MESSAGE}"),
            format!("issues/42?m={MESSAGE}"),
            format!("approvals?open={MESSAGE}"),
            format!("notifications?open={MESSAGE}"),
        ] {
            assert!(
                configured_target(&target(&path), &servers()).is_some(),
                "{path}"
            );
        }
    }

    #[test]
    fn full_length_cjk_person_id_survives_nested_uri_encoding() {
        let mut page = Url::parse(&target("home")).unwrap();
        page.set_path(&format!("/org/{ORG}/dm/person/{}", "張".repeat(160)));
        let outer = link(page.as_str());
        assert!(outer.as_str().len() > 2048);
        assert!(outer.as_str().len() <= MAX_NAVIGATION_LINK);
        assert_eq!(navigation_link(&outer, &servers()).unwrap(), page);
        let oversized = link(&format!("{}{}", target("dm/person/"), "a".repeat(MAX_TARGET)));
        assert!(navigation_link(&oversized, &servers()).is_none());
    }

    #[test]
    fn permits_another_workspace_on_the_already_configured_server() {
        let raw = format!("{SERVER}/org/{MESSAGE}/team");
        assert_eq!(
            navigation_link(&link(&raw), &servers()).unwrap().as_str(),
            raw
        );
    }

    #[test]
    fn does_not_add_servers_or_accept_credentials_and_callbacks() {
        for raw in [
            target("home").replace(SERVER, "https://other.example"),
            target("home").replace("https://", "https://user:pass@"),
            format!("{SERVER}/api/admin"),
            format!("{SERVER}/desktop/handover#token=secret"),
            target("team#secret"),
            "file:///tmp/panel".into(),
        ] {
            assert!(navigation_link(&link(&raw), &servers()).is_none(), "{raw}");
        }
        assert!(navigation_link(&link(&target("home")), &[]).is_none());
    }

    #[test]
    fn validates_opaque_person_ids_once() {
        for id in [
            "better-auth-user_42",
            "auth0%7Cuser-42",
            "person%3Aone%40example.com",
            "%E5%BC%B5%E4%B8%89",
        ] {
            assert!(
                configured_target(&target(&format!("dm/person/{id}?m={MESSAGE}")), &servers())
                    .is_some(),
                "{id}"
            );
        }
        for id in [
            "", ".", "..", "a%2Fb", "a%5Cb", "a%252Fb", "a%00b", "a%20b", "a%3Fb", "a%23b",
            "a%3ab", "%ff",
        ] {
            assert!(
                configured_target(&target(&format!("dm/person/{id}")), &servers()).is_none(),
                "{id}"
            );
        }
    }

    #[test]
    fn refuses_ambiguous_or_non_navigation_queries() {
        for path in [
            format!("c/{AGENT}?m={MESSAGE}&m={AGENT}"),
            format!("c/{AGENT}?m=bad"),
            format!("c/{AGENT}?open={MESSAGE}"),
            format!("home?m={MESSAGE}"),
            format!("approvals?open={MESSAGE}&redirect=https://evil.example"),
            format!("dm/agent/{AGENT}?send=hello"),
        ] {
            assert!(
                configured_target(&target(&path), &servers()).is_none(),
                "{path}"
            );
        }
        assert!(configured_target(&target("../login"), &servers()).is_none());
        assert!(configured_target(&target("%2e%2e/login"), &servers()).is_none());
    }

    #[test]
    fn outer_contract_rejects_extra_fields_path_user_and_fragment() {
        let good = link(&target("home")).to_string();
        for raw in [
            format!("{good}&url=another"),
            format!("{good}&ticket=abcdefghijklmnop"),
            format!("{good}#fragment"),
            good.replace("://navigate", "://person@navigate"),
            good.replace("://navigate?", "://navigate/other?"),
        ] {
            assert!(navigation_link(&Url::parse(&raw).unwrap(), &servers()).is_none());
        }
    }

    #[test]
    fn panel_launch_is_fixed_to_loopback_and_ticket_is_bounded() {
        let url = Url::parse("agenteschat://command-deck?ticket=abcdefghijklmnopqrstuvwxyz_12345")
            .unwrap();
        let page = panel_link(&url).unwrap();
        assert_eq!(
            page.as_str(),
            "http://127.0.0.1:17374/launch?ticket=abcdefghijklmnopqrstuvwxyz_12345"
        );
        assert!(panel_page(&page));
        for ticket in [
            "short".into(),
            "a".repeat(257),
            "abc/defghijklmnop".into(),
            "abcdefghijklmnop=".into(),
        ] {
            let mut bad = Url::parse("agenteschat://command-deck").unwrap();
            bad.query_pairs_mut().append_pair("ticket", &ticket);
            assert!(panel_link(&bad).is_none());
        }
    }

    #[test]
    fn panel_never_navigates_to_another_origin_or_non_panel_page() {
        assert!(panel_page(
            &Url::parse(&format!("{PANEL_ORIGIN}/panel")).unwrap()
        ));
        for raw in [
            "http://localhost:17374/panel",
            "http://127.0.0.1:17375/panel",
            "https://127.0.0.1:17374/panel",
            "http://u:p@127.0.0.1:17374/panel",
            "http://127.0.0.1:17374/state",
            "http://127.0.0.1:17374/panel?redirect=x",
            "http://127.0.0.1:17374/panel#x",
            "http://127.0.0.1:17374/launch?ticket=abcdefghijklmnop&ticket=qrstuvwxyzabcdef",
            "https://evil.example/panel",
            "file:///tmp/panel",
        ] {
            assert!(!panel_page(&Url::parse(raw).unwrap()), "{raw}");
        }
    }
}
