import { useCallback, useState } from 'react';
import {
  api,
  SshConnectionCreateInput,
  SshConnectionDetail,
  SshConnectionUpdateInput,
  SshTestResult,
} from '../../../api/client';

interface MutationState {
  pending: boolean;
  error: string | null;
}

const initialState: MutationState = { pending: false, error: null };

function useMutation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
): [(...args: TArgs) => Promise<TResult>, MutationState] {
  const [state, setState] = useState<MutationState>(initialState);
  const run = useCallback(
    async (...args: TArgs) => {
      setState({ pending: true, error: null });
      try {
        const result = await fn(...args);
        setState({ pending: false, error: null });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState({ pending: false, error: message });
        throw err;
      }
    },
    [fn],
  );
  return [run, state];
}

/**
 * Create a fresh SshConnection. The backend handles the atomic flow
 * (DTO validation → optional Secret creation → connection insert →
 * ownership patch with rollback on failure — Spec §5.4 step 2).
 */
export function useCreateSshConnection() {
  return useMutation<[SshConnectionCreateInput], SshConnectionDetail>(api.ssh.create);
}

export function useUpdateSshConnection() {
  return useMutation<[string, SshConnectionUpdateInput], SshConnectionDetail>(
    (id, patch) => api.ssh.update(id, patch),
  );
}

export function useDeleteSshConnection() {
  return useMutation<[string], void>((id) => api.ssh.delete(id));
}

/**
 * One-shot connect probe. Returns the structured `SshTestResult`; the caller
 * is responsible for interpreting `fingerprint` / `fingerprintMismatch` and
 * walking the TOFU dialog.
 */
export function useTestSshConnection() {
  return useMutation<[string], SshTestResult>((id) => api.ssh.test(id));
}

/**
 * Persist a user-accepted host-key fingerprint after the dialog confirmation.
 */
export function useAcceptSshFingerprint() {
  return useMutation<[string, string], SshConnectionDetail>(
    (id, fingerprint) => api.ssh.acceptFingerprint(id, fingerprint),
  );
}
