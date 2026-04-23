export interface Message {
  message_id: string;
  sender_name: string;
  sender_profile_url: string;
  direction: "incoming" | "outgoing";
  body: string;
  timestamp: string;
}

export interface Conversation {
  conversation_id: string;
  sender_name: string;
  sender_profile_url: string;
  unread: boolean;
  needs_reply: boolean;
  last_message_direction: string;
  last_message_preview: string;
  timestamp: string;
  messages: Message[];
}

export interface InboxResult {
  profile: string;
  account_name: string;
  scraped_at: string;
  status: "ok" | "not_logged_in" | "error" | "replied";
  conversations: Conversation[];
  error?: string;
}

export interface StatusMap {
  timestamp: string;
  profiles: Record<string, string>;
}

export interface ExperienceEntry {
  title: string;
  company: string;
  duration: string;
  location: string;
}

export interface EducationEntry {
  school: string;
  degree: string;
  years: string;
}

export interface ProfileResult {
  scraped_at: string;
  profile_url: string;
  chromium_profile: string;
  status: "ok" | "not_logged_in" | "error";
  name: string;
  headline: string;
  location: string;
  about: string;
  current_company: string;
  current_title: string;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  connection_degree: string;
  error?: string;
}

export interface NeedsReplyItem {
  inbox_json: string;
  profile_key: string;
  account_name: string;
  conversation_id: string;
  connection_name: string;
  last_incoming_message: string;
  messages: Message[];
  sender_profile_url: string;
  timestamp: string;
}

export interface FileSummary {
  source_file: string;
  profile: string;
  account_name: string;
  status: string;
  needs_reply: NeedsReplyItem[];
}

export interface InboxCheckSummary {
  checked_at: string;
  files: string[];
  results: FileSummary[];
}

export interface ReplyArgs {
  conversation_id: string;
  text: string;
}

// ── Mention checker ───────────────────────────────────────────────────────────

export interface Mention {
  mention_id: string;
  type: "comment_mention" | "post_mention" | "reaction_mention";
  author_name: string;
  author_profile_url: string;
  post_text: string;
  comment_text: string;
  post_url: string;
  timestamp: string;
  is_new: boolean;
}

export interface MentionResult {
  profile: string;
  account_name: string;
  scraped_at: string;
  status: "ok" | "not_logged_in" | "error";
  mentions: Mention[];
  new_mention_count: number;
  error?: string;
}

// ── API server payload types ──────────────────────────────────────────────────

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface RunAllResult {
  inbox: InboxResult[];
  mentions: MentionResult[];
  checked_at: string;
}

// Shape of the JS evaluate result in scrape_message_thread
export interface RawMessageEntry {
  idx: number;
  sender: string;
  sender_url: string;
  body: string;
  ts: string;
}

// Shape of the JS evaluate result in scrape_linkedin_profile
export interface RawProfileData {
  name: string;
  headline: string;
  location: string;
  connectionDegree: string;
  about: string;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  currentTitle: string;
  currentCompany: string;
}
