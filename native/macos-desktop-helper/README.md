# macOS desktop helper

Build on macOS 14+ with `swift build -c release`. The release binary must be code-signed with Accessibility and Screen Recording usage descriptions, copied to `bin/ai-test-officer-desktop-helper`, and its SHA-256 configured as `DESKTOP_HELPER_SHA256`. The Node adapter refuses missing, unsigned-by-policy, non-allowlisted, or unapproved operations.
