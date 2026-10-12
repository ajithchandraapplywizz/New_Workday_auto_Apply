/**
 * tokenUsage.ts — Helper module for calculating token costs and persisting records
 * ==============================================================================
 * Tracks exact token consumption (prompt, completion, cache read/write) and
 * monetary expenses ($) per application for LLM calls (OpenRouter / OpenAI / Gemini).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ModelPricing {
  prompt: number;        // USD per 1,000,000 prompt tokens
  completion: number;    // USD per 1,000,000 completion tokens
  cache_read: number;    // USD per 1,000,000 cache-read tokens
  cache_write: number;   // USD per 1,000,000 cache-write tokens
}

/**
 * OpenRouter & direct provider pricing matrix (per 1,000,000 tokens in USD).
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'openai/gpt-4o-mini': {
    prompt: 0.15,
    completion: 0.60,
    cache_read: 0.075,
    cache_write: 0.15,
  },
  'openai/gpt-4o': {
    prompt: 2.50,
    completion: 10.00,
    cache_read: 1.25,
    cache_write: 2.50,
  },
  // Google Gemini
  'google/gemini-2.5-flash-lite': {
    prompt: 0.075,
    completion: 0.30,
    cache_read: 0.01875,
    cache_write: 0.075,
  },
  'google/gemini-2.0-flash-lite': {
    prompt: 0.075,
    completion: 0.30,
    cache_read: 0.01875,
    cache_write: 0.075,
  },
  'google/gemini-2.0-flash-001': {
    prompt: 0.10,
    completion: 0.40,
    cache_read: 0.025,
    cache_write: 0.10,
  },
  'google/gemini-flash-1.5': {
    prompt: 0.075,
    completion: 0.30,
    cache_read: 0.01875,
    cache_write: 0.075,
  },
  // Meta Llama
  'meta-llama/llama-3.3-70b-instruct': {
    prompt: 0.13,
    completion: 0.40,
    cache_read: 0.065,
    cache_write: 0.13,
  },
  // Anthropic Claude
  'anthropic/claude-3-5-haiku': {
    prompt: 0.80,
    completion: 4.00,
    cache_read: 0.08,
    cache_write: 1.00,
  },
  'anthropic/claude-3-haiku': {
    prompt: 0.25,
    completion: 1.25,
    cache_read: 0.03,
    cache_write: 0.30,
  },
  // Fallback default pricing
  default: {
    prompt: 0.15,
    completion: 0.60,
    cache_read: 0.075,
    cache_write: 0.15,
  },
};

export interface TokenCostParams {
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface TokenCostBreakdown {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  prompt_cost: number;
  completion_cost: number;
  cache_read_cost: number;
  cache_write_cost: number;
  total_cost: number;
}

/**
 * Returns pricing rates for a given model identifier, matching exact prefix or canonical name.
 */
export function getModelPricing(model: string): ModelPricing {
  const normalized = (model || '').toLowerCase().trim();

  if (MODEL_PRICING[normalized]) {
    return MODEL_PRICING[normalized];
  }

  // Check matching key prefix or aliases
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== 'default' && (normalized.includes(key) || key.includes(normalized))) {
      return pricing;
    }
  }

  if (normalized.includes('gpt-4o-mini')) return MODEL_PRICING['openai/gpt-4o-mini'];
  if (normalized.includes('gpt-4o')) return MODEL_PRICING['openai/gpt-4o'];
  if (normalized.includes('gemini') && normalized.includes('flash')) return MODEL_PRICING['google/gemini-2.5-flash-lite'];
  if (normalized.includes('llama-3.3-70b')) return MODEL_PRICING['meta-llama/llama-3.3-70b-instruct'];

  return MODEL_PRICING.default;
}

/**
 * Calculates dollar cost for prompt, completion, and cache tokens.
 */
export function calculateTokenCost({
  model,
  prompt_tokens = 0,
  completion_tokens = 0,
  cache_read_tokens = 0,
  cache_write_tokens = 0,
}: TokenCostParams): TokenCostBreakdown {
  const pricing = getModelPricing(model);

  const prompt_cost = (prompt_tokens * pricing.prompt) / 1_000_000;
  const completion_cost = (completion_tokens * pricing.completion) / 1_000_000;
  const cache_read_cost = (cache_read_tokens * pricing.cache_read) / 1_000_000;
  const cache_write_cost = (cache_write_tokens * pricing.cache_write) / 1_000_000;

  const total_cost = prompt_cost + completion_cost + cache_read_cost + cache_write_cost;
  const total_tokens = prompt_tokens + completion_tokens;

  return {
    model,
    prompt_tokens,
    completion_tokens,
    cache_read_tokens,
    cache_write_tokens,
    total_tokens,
    prompt_cost: Number(prompt_cost.toFixed(6)),
    completion_cost: Number(completion_cost.toFixed(6)),
    cache_read_cost: Number(cache_read_cost.toFixed(6)),
    cache_write_cost: Number(cache_write_cost.toFixed(6)),
    total_cost: Number(total_cost.toFixed(6)),
  };
}

export interface RecordTokenUsageInput {
  applywizz_id: string;
  job_url: string;
  role: string;
  application_id?: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  metadata?: Record<string, any>;
  date?: string; // YYYY-MM-DD (defaults to current date)
  tableName?: string; // 'workday_application_token_usage' (default) or 'gh_application_token_usage'
}

export interface TokenUsageRecord {
  id: string;
  applywizz_id: string;
  job_url: string;
  role: string;
  application_id?: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  token_cost: number;
  date: string;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/**
 * Persists or aggregates LLM token usage for an application in Supabase.
 * If a row already exists for (applywizz_id, job_url, date), increments the tokens and cost.
 */
export async function recordTokenUsage(
  supabase: SupabaseClient,
  input: RecordTokenUsageInput
): Promise<TokenUsageRecord> {
  const table = input.tableName || 'workday_application_token_usage';
  const today = input.date || new Date().toISOString().split('T')[0];

  const {
    prompt_tokens,
    completion_tokens,
    cache_read_tokens,
    cache_write_tokens,
    total_tokens,
    total_cost,
  } = calculateTokenCost({
    model: input.model,
    prompt_tokens: input.prompt_tokens,
    completion_tokens: input.completion_tokens,
    cache_read_tokens: input.cache_read_tokens || 0,
    cache_write_tokens: input.cache_write_tokens || 0,
  });

  // Check if existing record exists for this application on this date
  const { data: existing, error: selectErr } = await supabase
    .from(table)
    .select('*')
    .eq('applywizz_id', input.applywizz_id)
    .eq('job_url', input.job_url)
    .eq('date', today)
    .maybeSingle();

  if (selectErr && selectErr.code !== 'PGRST116') {
    console.error(`[TokenUsage] Select error in ${table}:`, selectErr);
  }

  if (existing) {
    const updatedPrompt = (existing.prompt_tokens || 0) + prompt_tokens;
    const updatedCompletion = (existing.completion_tokens || 0) + completion_tokens;
    const updatedCacheRead = (existing.cache_read_tokens || 0) + cache_read_tokens;
    const updatedCacheWrite = (existing.cache_write_tokens || 0) + cache_write_tokens;
    const updatedTotalTokens = (existing.total_tokens || 0) + total_tokens;
    const updatedCost = Number((Number(existing.token_cost || 0) + total_cost).toFixed(6));

    const mergedMetadata = {
      ...(existing.metadata || {}),
      ...(input.metadata || {}),
      last_call_at: new Date().toISOString(),
      call_count: ((existing.metadata?.call_count as number) || 1) + 1,
    };

    const { data: updated, error: updateErr } = await supabase
      .from(table)
      .update({
        prompt_tokens: updatedPrompt,
        completion_tokens: updatedCompletion,
        cache_read_tokens: updatedCacheRead,
        cache_write_tokens: updatedCacheWrite,
        total_tokens: updatedTotalTokens,
        token_cost: updatedCost,
        metadata: mergedMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (updateErr) {
      console.error(`[TokenUsage] Update error in ${table}:`, updateErr);
      throw updateErr;
    }

    return updated as TokenUsageRecord;
  }

  // Insert fresh record
  const newRecord = {
    applywizz_id: input.applywizz_id,
    job_url: input.job_url,
    role: input.role,
    application_id: input.application_id || null,
    model: input.model,
    prompt_tokens,
    completion_tokens,
    cache_read_tokens,
    cache_write_tokens,
    total_tokens,
    token_cost: total_cost,
    date: today,
    metadata: {
      ...(input.metadata || {}),
      first_call_at: new Date().toISOString(),
      call_count: 1,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await supabase
    .from(table)
    .insert(newRecord)
    .select()
    .single();

  if (insertErr) {
    console.error(`[TokenUsage] Insert error in ${table}:`, insertErr);
    throw insertErr;
  }

  return inserted as TokenUsageRecord;
}

/**
 * Retrieves total token usage and cost for a given candidate application.
 */
export async function getApplicationTokenUsage(
  supabase: SupabaseClient,
  applywizz_id: string,
  job_url: string,
  tableName = 'workday_application_token_usage'
): Promise<TokenUsageRecord[]> {
  const { data, error } = await supabase
    .from(tableName)
    .select('*')
    .eq('applywizz_id', applywizz_id)
    .eq('job_url', job_url)
    .order('date', { ascending: false });

  if (error) {
    console.error(`[TokenUsage] Query error in ${tableName}:`, error);
    throw error;
  }

  return (data || []) as TokenUsageRecord[];
}

/**
 * Aggregates client-level token usage totals.
 */
export async function getClientTokenSummary(
  supabase: SupabaseClient,
  applywizz_id: string,
  tableName = 'workday_application_token_usage'
) {
  const { data, error } = await supabase
    .from(tableName)
    .select('prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, total_tokens, token_cost')
    .eq('applywizz_id', applywizz_id);

  if (error) {
    console.error(`[TokenUsage] Aggregate error in ${tableName}:`, error);
    throw error;
  }

  const totals = (data || []).reduce(
    (acc, row) => ({
      applications_count: acc.applications_count + 1,
      prompt_tokens: acc.prompt_tokens + (row.prompt_tokens || 0),
      completion_tokens: acc.completion_tokens + (row.completion_tokens || 0),
      cache_read_tokens: acc.cache_read_tokens + (row.cache_read_tokens || 0),
      cache_write_tokens: acc.cache_write_tokens + (row.cache_write_tokens || 0),
      total_tokens: acc.total_tokens + (row.total_tokens || 0),
      total_cost: Number((acc.total_cost + Number(row.token_cost || 0)).toFixed(6)),
    }),
    {
      applications_count: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      total_cost: 0,
    }
  );

  return totals;
}
