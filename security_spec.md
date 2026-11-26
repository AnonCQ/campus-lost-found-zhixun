# Security Specification — Smart Campus Lost & Found System (B-20)

## 1. Data Invariants
1. **Default Deny Catch-All**: Unmatched paths in `/databases/{database}/documents/{document=**}` are strictly denied.
2. **Path Variable Hardening (`isValidId`)**: All document ID variables (`userId`, `itemId`, `embeddingId`, `taskId`, `matchId`, `feedbackId`, `claimId`, `messageId`, `logId`) are bounded to `<= 256` characters and regex `^[a-zA-Z0-9_\-]+$`.
3. **Strict Schema Validation**: Every collection (`users`, `items`, `image_embeddings`, `recognition_tasks`, `matches`, `match_feedback`, `claims`, `messages`, `audit_logs`) validates required keys, bounded string lengths, and valid enum states via `isValid[Entity]`.
4. **Admin Whitelist**: Admin role (`shx614519@gmail.com`) is verified via `request.auth.token.email == 'shx614519@gmail.com' && request.auth.token.email_verified == true` or via the `/admins/$(request.auth.uid)` lookup.

## 2. The "Dirty Dozen" Payloads
1. **Ghost Field Injection (`items`)**: `{ id: "item_1", type: "lost", ..., ghostAdminFlag: true }` -> Rejected by `hasOnly`.
2. **Oversized Title (`items`)**: `{ id: "item_1", title: "A".repeat(5000) }` -> Rejected by `title.size() <= 200`.
3. **Invalid Enum Type (`items`)**: `{ id: "item_1", type: "stolen" }` -> Rejected by `type in ['lost', 'found']`.
4. **ID Poisoning (`items`)**: Document ID containing spaces/slashes or `> 256` chars -> Rejected by `isValidId`.
5. **Unbounded Vector Array (`image_embeddings`)**: `vector` with 2048 elements -> Rejected by `vector.size() <= 256`.
6. **Negative Retry Count (`recognition_tasks`)**: `retryCount: -5` -> Rejected by `retryCount >= 0`.
7. **Out-of-Bounds Match Score (`matches`)**: `totalScore: 9999` -> Rejected by `totalScore >= 0 && totalScore <= 100`.
8. **Invalid Feedback Action (`match_feedback`)**: `action: "drop_table"` -> Rejected by `action in ['confirm', 'exclude', 'restore', 'correct_category']`.
9. **Empty Verification Answer (`claims`)**: `verificationAnswer: ""` -> Rejected by `verificationAnswer.size() >= 1`.
10. **Oversized Message Content (`messages`)**: `content` > 1000 chars -> Rejected by `content.size() <= 1000`.
11. **Privilege Escalation in `users`**: Non-admin user attempting to set `role: 'admin'` without matching whitelist email -> Rejected by role check.
12. **Orphaned Audit Log with Oversized Detail**: `detail` > 1000 chars -> Rejected by `isValidAuditLog`.
