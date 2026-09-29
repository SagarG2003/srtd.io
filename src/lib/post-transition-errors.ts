// Friendly, inline copy for a failed stage_transition. The proc owns the policy:
// it raises forbidden_role when the role lacks approve/reject capability and
// invalid_stage_transition for an illegal move. Shared by the post detail page
// and the chat post sheet so both surfaces word a failure the same way.

import type { DomainError } from '@srtdio/rpc';

export function friendlyTransitionError(error: DomainError): string {
  switch (error.code) {
    case 'forbidden_role':
      return 'You do not have permission to make this change.';
    case 'invalid_stage_transition':
      return 'That move is not allowed from the current stage.';
    case 'workspace_member_only':
      return 'You must be a member of this workspace to make this change.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
