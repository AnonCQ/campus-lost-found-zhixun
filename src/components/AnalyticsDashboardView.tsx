/**
 * Data Visualization, Deep Learning Telemetry & 3-Strategy Evaluation Dashboard
 *
 * Built with Recharts + FastAPI (/api/analytics/overview, /api/eval/run, /api/tasks/:id/retry, /api/seed):
 * 1. Core KPI metrics (Active Items, Recovery Rate, OpenCLIP 512D Cache, YOLO26n Latency)
 * 2. Local GPU & Model Runtime Telemetry (NVIDIA CUDA, yolo26n.pt SHA-256, OpenCLIP ViT-B/32)
 * 3. Interactive Recharts Visualizations:
 *    - Category Distribution (Lost / Found / Returned)
 *    - Campus High-Frequency Location Hotspots
 *    - Item Lifecycle Status Funnel
 *    - Daily Lost & Found Trend
 * 4. Independent 3-Strategy Offline Benchmark Evaluation Runner (dataset / dataset_control / dataset_blind)
 * 5. Recognition Task Queue Monitor (with manual retry) & Admin Seed Reset
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
  AreaChart,
  Area,
} from 'recharts';
import {
  Activity,
  BarChart3,
  Cpu,
  Database,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Play,
  Layers,
  MapPin,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { LostFoundItem, RecognitionTask, UserProfile } from '../types/models';
import {
  AnalyticsOverviewPayload,
  fetchAnalyticsOverview,
  resetToDeterministic12DemoData,
  retryRecognitionTask,
  runBackendEvaluation,
} from '../services/firestoreService';

interface AnalyticsDashboardViewProps {
  currentUser: UserProfile;
  items: LostFoundItem[];
  tasks: RecognitionTask[];
  onDataMutated: () => Promise<void>;
}

export const AnalyticsDashboardView: React.FC<AnalyticsDashboardViewProps> = ({
  currentUser,
  items,
  tasks,
  onDataMutated,
}) => {
  const [analytics, setAnalytics] = useState<AnalyticsOverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Evaluation benchmark state
  const [evalDatasetKey, setEvalDatasetKey] = useState<'dataset' | 'dataset_control' | 'dataset_blind'>('dataset');
  const [evalReport, setEvalReport] = useState<any | null>(null);
  const [runningEval, setRunningEval] = useState(false);

  // Task retry & seed reset state
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [resettingSeed, setResettingSeed] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [ana, rep] = await Promise.all([
        fetchAnalyticsOverview(),
        runBackendEvaluation(evalDatasetKey),
      ]);
      setAnalytics(ana);
      setEvalReport(rep);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '加载数据分析失败');
    } finally {
      setLoading(false);
    }
  }, [evalDatasetKey]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const handleRunEval = async (key: 'dataset' | 'dataset_control' | 'dataset_blind') => {
    setEvalDatasetKey(key);
    setRunningEval(true);
    try {
      const rep = await runBackendEvaluation(key);
      setEvalReport(rep);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '评测运行失败');
    } finally {
      setRunningEval(false);
    }
  };

  const handleRetryTask = async (task: RecognitionTask) => {
    const targetItem = items.find((i) => i.id === task.itemId);
    if (!targetItem) return;
    setRetryingTaskId(task.id);
    try {
      await retryRecognitionTask(task, targetItem, currentUser);
      setToastMsg(`识别任务 ${task.id} 已重新执行完成`);
      await onDataMutated();
      await loadAnalytics();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '重试失败');
    } finally {
      setRetryingTaskId(null);
    }
  };

  const handleResetDemo = async () => {
    setResettingSeed(true);
    setToastMsg(null);
    try {
      await resetToDeterministic12DemoData(currentUser, 'reset');
      await onDataMutated();
      await loadAnalytics();
      setToastMsg('已通过 FastAPI 重置 16 条初始演示数据并重建 OpenCLIP 512D 图像向量索引');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '重置演示数据失败');
    } finally {
      setResettingSeed(false);
    }
  };

  if (loading && !analytics) {
    return (
      <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400 space-y-2">
        <RefreshCw className="w-6 h-6 animate-spin mx-auto text-[#FF6B2C]" />
        <p>正在从 FastAPI 聚合可视化统计与深度学习模型指标...</p>
      </div>
    );
  }

  const summary = analytics?.summary;
  const telemetry = analytics?.aiTelemetry;

  const evalChartData = (evalReport?.strategies || []).map((s: any) => ({
    name:
      s.strategyKey === 'rule_7d'
        ? '原7维规则'
        : s.strategyKey === 'rule_7d_plus_clip'
        ? '7维+视觉'
        : '三路+重排',
    Precision: s.precision,
    Recall: s.recall,
    F1: s.f1,
    'Recall@1': s.recallAt1,
    'Recall@3': s.recallAt3,
  }));

  return (
    <div className="space-y-4 pb-8">
      {errorMsg && (
        <div className="p-3 rounded-2xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
      {toastMsg && (
        <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* 1. AI Model & Hardware Runtime Card */}
      <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white rounded-3xl p-4 shadow-md space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-orange-500/20 text-orange-400 flex items-center justify-center">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-black tracking-tight">本地深度学习推理与数据库架构</div>
              <div className="text-[10px] text-slate-300">
                FastAPI + SQLAlchemy (SQLite/MySQL) · {telemetry?.gpuName || 'CPU'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={loadAnalytics}
            className="px-2.5 py-1 rounded-xl bg-white/10 hover:bg-white/20 text-[11px] font-bold flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10">
            <div className="text-slate-400 text-[10px]">目标检测模型 (CV)</div>
            <div className="font-bold text-orange-300 mt-0.5">
              Ultralytics {telemetry?.yoloModel || 'yolo26n.pt'}
            </div>
            <div className="text-[10px] text-slate-400 font-mono truncate mt-0.5">
              {telemetry?.yoloNumClasses || 80} 类 · SHA256: {telemetry?.yoloSha256?.slice(0, 10) || 'verified'}
            </div>
          </div>
          <div className="p-2.5 rounded-2xl bg-white/5 border border-white/10">
            <div className="text-slate-400 text-[10px]">图像特征编码器 (Embedding)</div>
            <div className="font-bold text-sky-300 mt-0.5">
              OpenCLIP {telemetry?.clipModel || 'ViT-B-32'}
            </div>
            <div className="text-[10px] text-slate-400 font-mono mt-0.5">
              {telemetry?.embeddingDimension || 512}D L2 归一化 · {telemetry?.device?.toUpperCase() || 'CUDA'}
            </div>
          </div>
        </div>
      </div>

      {/* 2. Top 4 KPI Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-2.5">
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-3.5 border border-slate-100 dark:border-slate-800 shadow-2xs">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <Database className="w-3.5 h-3.5 text-[#FF6B2C]" />
              <span>在库活跃物品</span>
            </div>
            <div className="text-2xl font-black font-mono text-slate-950 dark:text-white mt-1">
              {summary.totalItems}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              失物 {summary.lostCount} · 拾物 {summary.foundCount} · 归还 {summary.returnedCount}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl p-3.5 border border-slate-100 dark:border-slate-800 shadow-2xs">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
              <span>智能匹配与闭环</span>
            </div>
            <div className="text-2xl font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
              {summary.totalMatches} <span className="text-xs font-bold">对</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              高分(&ge;75) {summary.highScoreMatches} · 认领单 {summary.totalClaims}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl p-3.5 border border-slate-100 dark:border-slate-800 shadow-2xs">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <Layers className="w-3.5 h-3.5 text-blue-500" />
              <span>特征缓存向量库</span>
            </div>
            <div className="text-2xl font-black font-mono text-blue-600 dark:text-blue-400 mt-1">
              {summary.totalEmbeddings}
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              SHA-256 缓存命中率 {summary.cacheHitRate}%
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl p-3.5 border border-slate-100 dark:border-slate-800 shadow-2xs">
            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
              <Activity className="w-3.5 h-3.5 text-purple-500" />
              <span>平均识别置信度</span>
            </div>
            <div className="text-2xl font-black font-mono text-purple-600 dark:text-purple-400 mt-1">
              {summary.avgConfidence}%
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              平均耗时 {summary.avgLatencyMs} ms · 成功 {summary.succeededTasks}/{summary.totalTasks}
            </div>
          </div>
        </div>
      )}

      {/* 3. Category Distribution Chart */}
      {analytics && analytics.categoryDistribution.length > 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 border border-slate-100 dark:border-slate-800 shadow-2xs space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
              <BarChart3 className="w-4 h-4 text-[#FF6B2C]" />
              <span>校园失物/拾物分类分布</span>
            </div>
            <span className="text-[10px] text-slate-400">SQLite 实时聚合</span>
          </div>
          <div className="h-52 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.categoryDistribution} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.5} />
                <XAxis dataKey="category" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="lost" name="失物" fill="#FF6B2C" radius={[4, 4, 0, 0]} />
                <Bar dataKey="found" name="拾物" fill="#0066CC" radius={[4, 4, 0, 0]} />
                <Bar dataKey="returned" name="已归还" fill="#10B981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* 4. Campus Location Hotspots & Daily Trend */}
      {analytics && analytics.locationHotspots.length > 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 border border-slate-100 dark:border-slate-800 shadow-2xs space-y-2.5">
          <div className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
            <MapPin className="w-4 h-4 text-[#0066CC]" />
            <span>校园高频遗失 / 拾获区域统计</span>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.locationHotspots} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.5} />
                <XAxis dataKey="area" tick={{ fontSize: 10 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="lost" name="遗失频次" fill="#F97316" stackId="a" radius={[0, 0, 0, 0]} />
                <Bar dataKey="found" name="拾获频次" fill="#3B82F6" stackId="a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {analytics && analytics.dailyTrend.length > 0 && (
        <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 border border-slate-100 dark:border-slate-800 shadow-2xs space-y-2.5">
          <div className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
            <Activity className="w-4 h-4 text-emerald-500" />
            <span>每日登记与招领趋势</span>
          </div>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analytics.dailyTrend} margin={{ top: 6, right: 8, left: -22, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => String(v).slice(5)} />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="lost" name="失物登记" stroke="#FF6B2C" fill="#FF6B2C" fillOpacity={0.2} />
                <Area type="monotone" dataKey="found" name="拾物登记" stroke="#0066CC" fill="#0066CC" fillOpacity={0.2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* 5. Independent 3-Strategy Offline Evaluation Benchmark */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 border border-slate-100 dark:border-slate-800 shadow-2xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-black text-slate-900 dark:text-white flex items-center gap-1.5">
              <Play className="w-4 h-4 text-purple-600" />
              <span>三策略匹配算法离线评测对比</span>
            </div>
            <div className="text-[10px] text-slate-500 mt-0.5">
              FastAPI 实时执行 Precision / Recall / F1 / Recall@K 指标验证
            </div>
          </div>

          <div className="flex items-center gap-1">
            {(
              [
                ['dataset', '主集(40)'],
                ['dataset_control', '控制集(30)'],
                ['dataset_blind', '盲测集(12)'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                disabled={runningEval}
                onClick={() => handleRunEval(key)}
                className={`px-2.5 py-1 rounded-xl text-[11px] font-bold cursor-pointer transition-colors ${
                  evalDatasetKey === key
                    ? 'bg-purple-600 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {evalChartData.length > 0 && (
          <div className="h-52 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={evalChartData} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.5} />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 11, borderRadius: 12 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="Precision" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Recall" fill="#F97316" radius={[4, 4, 0, 0]} />
                <Bar dataKey="F1" fill="#10B981" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Recall@1" fill="#8B5CF6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {evalReport?.strategies && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700 text-slate-500">
                  <th className="py-1.5 pr-2">策略</th>
                  <th className="py-1.5 px-1.5 font-mono">P%</th>
                  <th className="py-1.5 px-1.5 font-mono">R%</th>
                  <th className="py-1.5 px-1.5 font-mono">F1%</th>
                  <th className="py-1.5 px-1.5 font-mono">R@1</th>
                  <th className="py-1.5 px-1.5 font-mono">R@3</th>
                  <th className="py-1.5 pl-1.5 font-mono">耗时</th>
                </tr>
              </thead>
              <tbody>
                {evalReport.strategies.map((s: any) => (
                  <tr
                    key={s.strategyKey}
                    className={`border-b border-slate-100 dark:border-slate-800 ${
                      s.strategyKey === 'three_way_rerank'
                        ? 'bg-emerald-50/60 dark:bg-emerald-950/30 font-bold'
                        : ''
                    }`}
                  >
                    <td className="py-1.5 pr-2 text-slate-800 dark:text-slate-200">
                      {s.strategyKey === 'rule_7d'
                        ? '原7维规则'
                        : s.strategyKey === 'rule_7d_plus_clip'
                        ? '7维+视觉'
                        : '三路+重排'}
                    </td>
                    <td className="py-1.5 px-1.5 font-mono">{s.precision}</td>
                    <td className="py-1.5 px-1.5 font-mono">{s.recall}</td>
                    <td className="py-1.5 px-1.5 font-mono text-emerald-600 dark:text-emerald-400">
                      {s.f1}
                    </td>
                    <td className="py-1.5 px-1.5 font-mono">{s.recallAt1}</td>
                    <td className="py-1.5 px-1.5 font-mono">{s.recallAt3}</td>
                    <td className="py-1.5 pl-1.5 font-mono">{s.avgLatencyMs}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 6. Recognition Task Queue & Admin Controls */}
      <div className="bg-white dark:bg-slate-900 rounded-3xl p-4 border border-slate-100 dark:border-slate-800 shadow-2xs space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-black text-slate-900 dark:text-white">
              视觉识别任务监控队列 ({tasks.length})
            </div>
            <div className="text-[10px] text-slate-500">
              YOLO26n 目标检测 + OpenCLIP 特征编码任务追踪，支持手动重试
            </div>
          </div>

          {currentUser.role === 'admin' && (
            <button
              type="button"
              disabled={resettingSeed}
              onClick={handleResetDemo}
              className="px-3 py-1.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-[11px] font-bold flex items-center gap-1 cursor-pointer disabled:opacity-50"
            >
              <RotateCcw className={`w-3 h-3 ${resettingSeed ? 'animate-spin' : ''}`} />
              <span>{resettingSeed ? '重置中...' : '重置演示库'}</span>
            </button>
          )}
        </div>

        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {tasks.slice(0, 12).map((t) => (
            <div
              key={t.id}
              className="p-2.5 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200/70 dark:border-slate-700 flex items-center justify-between gap-2 text-[11px]"
            >
              <div className="min-w-0 flex-1">
                <div className="font-bold text-slate-900 dark:text-white truncate">
                  {t.itemTitle || t.itemId}
                </div>
                <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate mt-0.5">
                  {t.rawModelClass || 'object'} → {t.mappedCampusCategory} ·{' '}
                  {((t.confidence || 0) * 100).toFixed(1)}% · {t.latencyMs || 0}ms
                  {t.cacheHit ? ' · 缓存命中' : ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span
                  className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                    t.status === 'succeeded'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                      : t.status === 'failed'
                      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {t.status}
                </span>
                <button
                  type="button"
                  disabled={retryingTaskId === t.id}
                  onClick={() => handleRetryTask(t)}
                  title="使用 YOLO26n + OpenCLIP 重新识别"
                  className="px-2 py-1 rounded-lg bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-[10px] font-bold text-slate-700 dark:text-slate-200 hover:border-[#FF6B2C] cursor-pointer disabled:opacity-50"
                >
                  {retryingTaskId === t.id ? '推理中...' : '重跑模型'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
