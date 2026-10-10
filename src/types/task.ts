export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'needs_approval';

export type TaskKind = 'user_request' | 'scheduled_job' | 'proactive_check';

export interface Task {
  id: string;
  origin_channel: string;
  origin_chat_id: string | null;
  session_id: string | null;
  kind: TaskKind;
  skill_name: string | null;
  input: string;
  input_type: string;
  status: TaskStatus;
  result: string | null;
  error_detail: string | null;
  attempts: number;
  max_attempts: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  notified_at: number | null;
}

export interface NewTask {
  origin_channel: string;
  origin_chat_id?: string | null;
  session_id?: string | null;
  kind: TaskKind;
  skill_name?: string | null;
  input: string;
  input_type?: string;
  max_attempts?: number;
}
