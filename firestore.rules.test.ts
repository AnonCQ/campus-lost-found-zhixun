/**
 * Firestore Security Rules Test Suite Specification (Dirty Dozen Verification)
 */
export interface SecurityTestCase {
  id: string;
  collection: string;
  operation: 'create' | 'update' | 'delete' | 'get';
  payload: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: SecurityTestCase[] = [
  {
    id: 'DD-01-ghost-field',
    collection: 'items',
    operation: 'create',
    payload: { id: 'item_1', type: 'lost', title: '傘', ghostField: 'hack' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-02-oversized-title',
    collection: 'items',
    operation: 'create',
    payload: { id: 'item_1', type: 'lost', title: 'X'.repeat(300) },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-03-invalid-item-type',
    collection: 'items',
    operation: 'create',
    payload: { id: 'item_1', type: 'invalid_type', title: '测试' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-04-id-poisoning',
    collection: 'items',
    operation: 'create',
    payload: { id: 'bad$id!@#', type: 'lost', title: '测试' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-05-oversized-embedding',
    collection: 'image_embeddings',
    operation: 'create',
    payload: { id: 'emb_1', sha256: 'abc', vector: new Array(500).fill(0.1) },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-06-invalid-task-status',
    collection: 'recognition_tasks',
    operation: 'create',
    payload: { id: 'task_1', status: 'hacked', retryCount: -1 },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-07-invalid-match-score',
    collection: 'matches',
    operation: 'create',
    payload: { id: 'match_1_2', totalScore: 500 },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-08-invalid-feedback-action',
    collection: 'match_feedback',
    operation: 'create',
    payload: { id: 'fb_1', action: 'sudo_rm' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-09-empty-claim-answer',
    collection: 'claims',
    operation: 'create',
    payload: { id: 'claim_1', verificationAnswer: '' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-10-oversized-message',
    collection: 'messages',
    operation: 'create',
    payload: { id: 'msg_1', content: 'M'.repeat(2000) },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-11-self-assigned-admin',
    collection: 'users',
    operation: 'create',
    payload: { uid: 'u1', email: 'student@campus.edu.cn', role: 'admin' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 'DD-12-oversized-audit-log',
    collection: 'audit_logs',
    operation: 'create',
    payload: { id: 'log_1', detail: 'D'.repeat(2000) },
    expectedResult: 'PERMISSION_DENIED',
  },
];
