/**
 * 智寻校园 AI 寻物助手 (RAG + Tool-Calling LLM Agent Drawer)
 *
 * Features:
 * - Multi-turn natural language dialogue powered by FastAPI /api/agent/chat
 *   (Google Gemini 3.5 Flash / OpenAI-compatible Function Calling + Local Tool Fallback)
 * - Live Hybrid RAG (TF-IDF Campus Knowledge Base + OpenCLIP Cross-Modal Visual Retrieval)
 * - Transparent Tool-Call Traces (shows exact tools invoked and latency)
 * - Expandable RAG Citation Cards (shows retrieved policy chunk, source, & cosine score)
 * - Clickable Recommended Item Cards (jumps straight to Item Detail Drawer)
 * - Structured Publish Draft Card + 1-Click "一键填入发布页" button
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Sparkles,
  Send,
  X,
  Wrench,
  BookOpen,
  MapPin,
  ChevronRight,
  FilePlus2,
  Loader2,
  Trash2,
  Cpu,
} from 'lucide-react';
import { CampusCategory, CampusLocationArea, LostFoundItem, UserProfile } from '../types/models';
import { ResilientItemImage } from './QrCodeSvg';

export interface AgentPublishDraft {
  type: 'lost' | 'found';
  title: string;
  description: string;
  campusCategory: CampusCategory;
  color?: string;
  brand?: string;
  locationArea: CampusLocationArea | string;
  locationDetail?: string;
  rewardAmount?: number;
  verificationQuestion?: string;
}

interface ToolTrace {
  tool: string;
  summary: string;
  latencyMs: number;
}

interface RagSource {
  id: string;
  category: string;
  title: string;
  source: string;
  content: string;
  score: number;
  retrievalMethod?: string;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  provider?: string;
  latencyMs?: number;
  toolTraces?: ToolTrace[];
  ragSources?: RagSource[];
  recommendedItems?: LostFoundItem[];
  publishDraft?: AgentPublishDraft | null;
}

interface AiAgentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile;
  onOpenItemDetail: (item: LostFoundItem) => void;
  onApplyPublishDraft: (draft: AgentPublishDraft) => void;
}

const QUICK_PROMPTS = [
  {
    label: '一卡通丢了怎么挂失补办？',
    badge: 'RAG 知识库',
    text: '我的校园一卡通在食堂丢了，应该怎么挂失和补办？各楼宇有暂存点吗？',
  },
  {
    label: '帮找图书馆银色电脑线索',
    badge: '智能匹配',
    text: '我在图书馆四楼丢了一台银色苹果 MacBook Pro，外壳有贴纸，帮我匹配一下有没有人捡到？',
  },
  {
    label: '帮我起草一条丢耳机寻物帖',
    badge: '智能拟稿',
    text: '帮我起草一条寻物启事：今天下午在三教201丢了一个白色 AirPods Pro 耳机充电盒，愿意悬赏20元。',
  },
  {
    label: '查询我的认领与交接进度',
    badge: '账号工具',
    text: '帮我查一下我当前的发帖、认领审核进度和钱包余额。',
  },
  {
    label: '学校哪里最容易丢东西？',
    badge: '数据统计',
    text: '统计一下学校目前哪些区域最容易丢东西？系统用了什么视觉模型？',
  },
];

export const AiAgentDrawer: React.FC<AiAgentDrawerProps> = ({
  isOpen,
  onClose,
  currentUser,
  onOpenItemDetail,
  onApplyPublishDraft,
}) => {
  const [agentMeta, setAgentMeta] = useState<{
    provider: string;
    model: string;
    ragDocumentsCount: number;
  } | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        '你好！我是「智寻校园」AI 寻物助手（RAG + Agent 工具调用）。\n\n我可以帮你：\n1. 📚 检索校园失物招领规章、挂失补办与各楼宇暂存点（RAG 知识库）\n2. 🔍 按口语描述调用 7 维匹配 + OpenCLIP 跨模态引擎检索疑似线索\n3. ✍️ 一键起草失物/拾物表单并自动填入发布页\n4. 📋 查询你的认领审核进度、交接码状态与全校统计数据',
    },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [expandedRagIds, setExpandedRagIds] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/agent/status')
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) {
          setAgentMeta({
            provider: d.provider,
            model: d.model,
            ragDocumentsCount: d.ragDocumentsCount || 10,
          });
        }
      })
      .catch(() => {});
  }, [isOpen]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, sending, isOpen]);

  if (!isOpen) return null;

  const sendMessage = async (textOverride?: string) => {
    const cleanText = (textOverride ?? input).trim();
    if (!cleanText || sending) return;

    const userTurn: ChatTurn = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: cleanText,
    };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    if (!textOverride) setInput('');
    setSending(true);

    try {
      const historyPayload = nextTurns
        .filter((t) => t.id !== 'welcome')
        .map((t) => ({ role: t.role, content: t.content }));

      const resp = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: historyPayload,
          currentUser: {
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            role: currentUser.role,
            email: currentUser.email,
          },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data?.detail || `服务响应错误 (${resp.status})`);
      }

      const aiTurn: ChatTurn = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: data.reply || '已完成查询。',
        model: data.model,
        provider: data.provider,
        latencyMs: data.latencyMs,
        toolTraces: data.toolTraces || [],
        ragSources: data.ragSources || [],
        recommendedItems: data.recommendedItems || [],
        publishDraft: data.publishDraft || null,
      };
      setTurns((prev) => [...prev, aiTurn]);
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `请求 AI 助手时遇到问题：${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/55 backdrop-blur-xs p-0 sm:p-4">
      <div className="bg-[#F6F7F9] dark:bg-slate-950 w-full max-w-[460px] h-[88vh] sm:h-[82vh] rounded-t-[30px] sm:rounded-[30px] shadow-2xl border border-slate-200/80 dark:border-slate-800 flex flex-col overflow-hidden">
        {/* Top Header */}
        <div className="px-4 py-3.5 bg-gradient-to-r from-slate-900 via-[#0F2447] to-slate-900 text-white flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-[#FF6B2C] to-amber-400 flex items-center justify-center shadow-sm shrink-0">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="text-sm font-black tracking-tight truncate">智寻 AI 寻物助手</h3>
                <span className="px-1.5 py-0.5 rounded-md bg-white/15 text-[9px] font-bold text-amber-200 shrink-0">
                  RAG + Agent
                </span>
              </div>
              <div className="text-[10px] text-slate-300 flex items-center gap-1.5 truncate mt-0.5">
                <Cpu className="w-3 h-3 text-emerald-400 shrink-0" />
                <span className="truncate">
                  {agentMeta ? `${agentMeta.model} · 知识库 ${agentMeta.ragDocumentsCount} 篇` : '连接 FastAPI Agent...'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setTurns((prev) => prev.slice(0, 1))}
              title="清空对话"
              className="p-2 rounded-full hover:bg-white/15 text-slate-300 hover:text-white cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="p-2 rounded-full hover:bg-white/15 text-slate-300 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Message List */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3.5 py-3.5 space-y-3.5">
          {turns.map((turn) => {
            const isUser = turn.role === 'user';
            return (
              <div
                key={turn.id}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} gap-2`}
              >
                {/* Tool-Call Trace Pills */}
                {!isUser && turn.toolTraces && turn.toolTraces.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 max-w-[92%]">
                    {turn.toolTraces.map((tr, idx) => (
                      <div
                        key={`${turn.id}_tr_${idx}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/70 border border-indigo-200/70 dark:border-indigo-800 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300"
                      >
                        <Wrench className="w-2.5 h-2.5 shrink-0" />
                        <span>{tr.summary}</span>
                        <span className="font-mono opacity-70">{tr.latencyMs}ms</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Chat Bubble */}
                <div
                  className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap shadow-2xs ${
                    isUser
                      ? 'bg-[#FF6B2C] text-white rounded-tr-sm'
                      : 'bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border border-slate-200/70 dark:border-slate-800 rounded-tl-sm'
                  }`}
                >
                  {turn.content}
                  {!isUser && turn.model && (
                    <div className="mt-2 pt-1.5 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 flex items-center justify-between gap-2 font-mono">
                      <span>{turn.model}</span>
                      {turn.latencyMs && <span>{turn.latencyMs}ms</span>}
                    </div>
                  )}
                </div>

                {/* RAG Knowledge Base Citation Cards */}
                {!isUser && turn.ragSources && turn.ragSources.length > 0 && (
                  <div className="w-[92%] space-y-1.5">
                    <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1 px-1">
                      <BookOpen className="w-3 h-3 text-emerald-600" />
                      <span>RAG 校园知识库引用依据 ({turn.ragSources.length})</span>
                    </div>
                    {turn.ragSources.map((src) => {
                      const key = `${turn.id}_${src.id}`;
                      const expanded = Boolean(expandedRagIds[key]);
                      return (
                        <div
                          key={key}
                          onClick={() =>
                            setExpandedRagIds((prev) => ({ ...prev, [key]: !prev[key] }))
                          }
                          className="p-2.5 rounded-2xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200/80 dark:border-emerald-800/70 cursor-pointer transition-colors hover:border-emerald-400"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-bold text-emerald-900 dark:text-emerald-200 truncate">
                              [{src.category}] {src.title}
                            </span>
                            <span className="px-1.5 py-0.5 rounded bg-emerald-600/15 text-emerald-800 dark:text-emerald-300 text-[10px] font-mono font-bold shrink-0">
                              相关度 {(src.score * 100).toFixed(0)}%
                            </span>
                          </div>
                          <div className="text-[10px] text-emerald-700/80 dark:text-emerald-400 mt-0.5">
                            来源：{src.source}
                          </div>
                          {expanded && (
                            <p className="text-[11px] text-slate-700 dark:text-slate-300 mt-1.5 pt-1.5 border-t border-emerald-200/70 dark:border-emerald-800/60 leading-relaxed">
                              {src.content}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Recommended Clickable Item Cards */}
                {!isUser && turn.recommendedItems && turn.recommendedItems.length > 0 && (
                  <div className="w-[92%] space-y-1.5">
                    <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 px-1">
                      检索到的在库关联物品 ({turn.recommendedItems.length})
                    </div>
                    {turn.recommendedItems.slice(0, 3).map((it) => (
                      <button
                        key={`${turn.id}_item_${it.id}`}
                        type="button"
                        onClick={() => {
                          onClose();
                          onOpenItemDetail(it);
                        }}
                        className="w-full p-2 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 hover:border-[#FF6B2C] flex items-center gap-2.5 text-left cursor-pointer transition-all shadow-2xs"
                      >
                        <ResilientItemImage
                          src={it.imageUrl}
                          alt={it.title}
                          category={it.campusCategory}
                          className="w-12 h-12 rounded-xl object-cover shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`px-1.5 py-0.2 rounded text-[9px] font-bold text-white shrink-0 ${
                                it.type === 'lost' ? 'bg-[#FF5000]' : 'bg-[#0066CC]'
                              }`}
                            >
                              {it.type === 'lost' ? '失物' : '拾物'}
                            </span>
                            <span className="text-xs font-bold text-slate-900 dark:text-white truncate">
                              {it.title}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center gap-1 mt-0.5 truncate">
                            <MapPin className="w-3 h-3 shrink-0" />
                            <span className="truncate">{it.location}</span>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Structured Publish Draft Card + 1-Click Autofill Button */}
                {!isUser && turn.publishDraft && (
                  <div className="w-[92%] p-3 rounded-2xl bg-orange-50/80 dark:bg-orange-950/40 border border-orange-200 dark:border-orange-800 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-black text-orange-950 dark:text-orange-200 flex items-center gap-1">
                        <Sparkles className="w-3.5 h-3.5 text-[#FF5000]" />
                        <span>
                          AI 结构化{turn.publishDraft.type === 'lost' ? '寻物' : '招领'}草稿已就绪
                        </span>
                      </span>
                      <span className="px-2 py-0.5 rounded-lg bg-white/80 dark:bg-slate-800 text-[10px] font-bold text-slate-700 dark:text-slate-200">
                        {turn.publishDraft.campusCategory}
                      </span>
                    </div>
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      {turn.publishDraft.title}
                    </div>
                    <div className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2">
                      {turn.publishDraft.description}
                    </div>
                    <div className="flex flex-wrap gap-1.5 text-[10px] text-slate-600 dark:text-slate-300">
                      <span className="px-2 py-0.5 rounded-md bg-white dark:bg-slate-800">
                        📍 {turn.publishDraft.locationArea}
                        {turn.publishDraft.locationDetail ? ` · ${turn.publishDraft.locationDetail}` : ''}
                      </span>
                      {turn.publishDraft.color && (
                        <span className="px-2 py-0.5 rounded-md bg-white dark:bg-slate-800">
                          🎨 {turn.publishDraft.color}
                        </span>
                      )}
                      {turn.publishDraft.type === 'lost' && (turn.publishDraft.rewardAmount || 0) > 0 && (
                        <span className="px-2 py-0.5 rounded-md bg-orange-100 text-[#FF5000] font-bold">
                          悬赏 ¥{turn.publishDraft.rewardAmount}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onApplyPublishDraft(turn.publishDraft!);
                        onClose();
                      }}
                      className="w-full py-2 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
                    >
                      <FilePlus2 className="w-3.5 h-3.5" />
                      <span>一键填入发布页并开启视觉匹配</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {sending && (
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 px-2">
              <Loader2 className="w-4 h-4 animate-spin text-[#FF6B2C]" />
              <span>AI 助手正在检索知识库并调用工具分析...</span>
            </div>
          )}
        </div>

        {/* Quick Prompt Chips */}
        <div className="px-3.5 py-2 bg-white/80 dark:bg-slate-900/80 border-t border-slate-200/70 dark:border-slate-800 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
          {QUICK_PROMPTS.map((qp) => (
            <button
              key={qp.label}
              type="button"
              disabled={sending}
              onClick={() => sendMessage(qp.text)}
              className="px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-orange-50 dark:hover:bg-slate-700 border border-slate-200/70 dark:border-slate-700 text-[11px] font-semibold text-slate-700 dark:text-slate-200 whitespace-nowrap flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-50"
            >
              <span className="text-[9px] px-1 py-0.2 rounded bg-[#FF6B2C]/15 text-[#FF5000] font-bold">
                {qp.badge}
              </span>
              <span>{qp.label}</span>
            </button>
          ))}
        </div>

        {/* Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendMessage();
          }}
          className="p-3 bg-white dark:bg-slate-900 border-t border-slate-200/80 dark:border-slate-800 flex items-center gap-2 shrink-0"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="问挂失流程、搜失物线索、或让我帮你起草帖子..."
            className="flex-1 px-3.5 py-2.5 rounded-2xl bg-slate-100 dark:bg-slate-800 dark:text-white text-xs focus:outline-none focus:ring-2 focus:ring-[#FF6B2C]/40"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="w-10 h-10 rounded-2xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-50 shadow-xs"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
