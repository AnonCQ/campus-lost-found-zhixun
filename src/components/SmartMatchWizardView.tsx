/**
 * Tab 3 (+ Button): Unified Publish & Smart Matching Flow (参考闲鱼底部「+」号发帖与智能匹配一体化设计)
 * - Step 0 (Entry Chooser): Pops up two clean option cards ("我东西丢了" / "我捡到东西了") modeled after Xianyu's publish sheet.
 * - Step 1 (Formal Publish & Match Form):
 *   - Formal production copy only (no demo presets, no technical jargon).
 *   - Single "上传图片" button; clicking it prompts the user to choose "从图库上传" or "打开摄像机拍照".
 * - Step 2 (Match Results & Direct Publish):
 *   - Automatically compares against existing Found/Lost posts; if no match fits, 1-click publishes the post.
 */

import React, { useRef, useState } from 'react';
import {
  Upload,
  Search,
  CheckCircle2,
  MapPin,
  MessageCircle,
  Loader2,
  AlertTriangle,
  Camera,
  Image as ImageIcon,
  ChevronLeft,
  X,
  FilePlus2,
  HandHeart,
} from 'lucide-react';
import {
  CAMPUS_CATEGORIES,
  CAMPUS_LOCATION_AREAS,
  CampusCategory,
  CampusLocationArea,
  composeCampusLocation,
  DEFAULT_MATCHING_CONFIG,
  ImageEmbedding,
  LostFoundItem,
  MatchRecord,
  UserProfile,
} from '../types/models';
import { processImageExifAndSha256, uploadCleanedImageToStorage } from '../lib/firebase';
import {
  getOrEncodeCachedEmbedding,
  publishItemWithRecognitionWorkflow,
  runAndPersistMatchesForItem,
  sendInSiteMessage,
} from '../services/firestoreService';
import { executeThreeWayRecallAndRerank } from '../services/matchingEngine';
import { ResilientItemImage } from './QrCodeSvg';

type EvaluatedCandidate = ReturnType<typeof executeThreeWayRecallAndRerank>['matches'][number];

interface SmartMatchWizardViewProps {
  items: LostFoundItem[];
  embeddings: ImageEmbedding[];
  matches: MatchRecord[];
  currentUser: UserProfile;
  onDataMutated: () => Promise<void>;
  onOpenChatForItem: (itemId: string) => void;
  onOpenItemDetail: (item: LostFoundItem) => void;
  onPublishedNewItem: (item: LostFoundItem) => void;
  onClosePublishTab?: () => void;
}

function getCurrentLocalDateTimeValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export const SmartMatchWizardView: React.FC<SmartMatchWizardViewProps> = ({
  items,
  embeddings,
  matches,
  currentUser,
  onDataMutated,
  onOpenChatForItem,
  onOpenItemDetail,
  onPublishedNewItem,
  onClosePublishTab,
}) => {
  // Step 0: Xianyu-style two-option chooser ('chooser' | 'form')
  const [stepMode, setStepMode] = useState<'chooser' | 'form'>('chooser');
  const [roleMode, setRoleMode] = useState<'lost' | 'found'>('lost');

  // Formal form fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [campusCategory, setCampusCategory] = useState<CampusCategory>('数码电子');
  const [userManuallySelectedCategory, setUserManuallySelectedCategory] = useState(false);
  const [color, setColor] = useState('');
  const [brand, setBrand] = useState('');
  const [rewardAmount, setRewardAmount] = useState<number>(0);
  const [locationArea, setLocationArea] = useState<CampusLocationArea>('图书馆');
  const [locationDetail, setLocationDetail] = useState('');
  const [eventTime, setEventTime] = useState<string>(() => getCurrentLocalDateTimeValue());
  const [verificationQuestion, setVerificationQuestion] = useState('');
  const availableWalletBalance =
    typeof currentUser.walletBalance === 'number' ? currentUser.walletBalance : 85;

  // Image state & single-button Upload/Camera Action Sheet
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [base64Image, setBase64Image] = useState<string>('');
  const [mimeType, setMimeType] = useState<string>('image/jpeg');
  const [imageSha256, setImageSha256] = useState<string>('');
  const [cleanBlob, setCleanBlob] = useState<Blob | null>(null);
  const [showImageSourcePrompt, setShowImageSourcePrompt] = useState(false);
  const [isCameraModalOpen, setIsCameraModalOpen] = useState(false);

  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Matching & publishing state
  const [matchingNow, setMatchingNow] = useState(false);
  const [publishingNow, setPublishingNow] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [candidateResults, setCandidateResults] = useState<
    Array<{ evalResult: EvaluatedCandidate; targetItem: LostFoundItem }>
  >([]);
  const [publishedSuccessItem, setPublishedSuccessItem] = useState<LostFoundItem | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [draftItemId, setDraftItemId] = useState<string>(() => `item_lost_${Date.now()}`);

  const runQuickCategoryRecognition = async (opts: {
    b64?: string;
    mType?: string;
    imgUrl?: string;
    titleText?: string;
    descText?: string;
  }) => {
    const b64 = opts.b64 !== undefined ? opts.b64 : base64Image;
    const mType = opts.mType !== undefined ? opts.mType : mimeType;
    const imgUrl = opts.imgUrl !== undefined ? opts.imgUrl : previewUrl;
    const titleText = (opts.titleText !== undefined ? opts.titleText : title).trim();
    const descText = (opts.descText !== undefined ? opts.descText : description).trim();
    if (!b64 && !imgUrl && !titleText && !descText) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch('/api/tasks/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          taskId: `task_auto_${Date.now()}`,
          itemId: draftItemId,
          idempotencyKey: `idem_auto_${draftItemId}_${titleText.slice(0, 16)}`,
          base64Image: b64 || undefined,
          mimeType: mType,
          imageUrl: imgUrl || undefined,
          title: titleText,
          description: descText,
        }),
      });
      if (!resp.ok) return;
      const recogData = await resp.json();
      const mapped: CampusCategory | undefined = recogData?.mappedCampusCategory;
      if (mapped && mapped !== 'unknown' && !userManuallySelectedCategory) {
        setCampusCategory(mapped);
      }
      if (!color.trim() && recogData?.color && recogData.color !== '未知') {
        setColor(recogData.color);
      }
      if (!brand.trim() && recogData?.brand) {
        setBrand(recogData.brand);
      }
    } catch {
      // Non-blocking quick recognition
    } finally {
      clearTimeout(timer);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setShowImageSourcePrompt(false);
    try {
      const processed = await processImageExifAndSha256(file);
      setPreviewUrl(processed.dataUrl);
      setBase64Image(processed.base64Data);
      setMimeType(processed.mimeType);
      setImageSha256(processed.sha256);
      setCleanBlob(processed.cleanBlob);
      void runQuickCategoryRecognition({
        b64: processed.base64Data,
        mType: processed.mimeType,
        imgUrl: processed.dataUrl,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '图片处理失败');
    }
  };

  const stopCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const handleOpenCamera = async () => {
    setShowImageSourcePrompt(false);
    // Try WebRTC camera first so both desktop and mobile browsers can take a live photo; fall back to input[capture]
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        streamRef.current = stream;
        setIsCameraModalOpen(true);
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {});
          }
        }, 80);
        return;
      } catch {
        // Fallback to native file input with capture="environment"
      }
    }
    cameraInputRef.current?.click();
  };

  const handleCapturePhotoFromVideo = async () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    stopCameraStream();
    setIsCameraModalOpen(false);

    canvas.toBlob(
      async (blob) => {
        if (!blob) return;
        const file = new File([blob], `camera_${Date.now()}.jpg`, { type: 'image/jpeg' });
        try {
          const processed = await processImageExifAndSha256(file);
          setPreviewUrl(processed.dataUrl);
          setBase64Image(processed.base64Data);
          setMimeType(processed.mimeType);
          setImageSha256(processed.sha256);
          setCleanBlob(processed.cleanBlob);
          void runQuickCategoryRecognition({
            b64: processed.base64Data,
            mType: processed.mimeType,
            imgUrl: processed.dataUrl,
          });
        } catch (err) {
          setErrorMsg(err instanceof Error ? err.message : '拍照处理失败');
        }
      },
      'image/jpeg',
      0.9
    );
  };

  const handleRunSmartMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) {
      setErrorMsg('请填写物品名称和外观特征描述');
      return;
    }
    if (roleMode === 'lost' && rewardAmount > availableWalletBalance) {
      setErrorMsg(
        `悬赏金额（¥${rewardAmount}）超出当前钱包可用余额（¥${availableWalletBalance}），请调低悬赏金额`
      );
      return;
    }

    setMatchingNow(true);
    setErrorMsg(null);
    setPublishedSuccessItem(null);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);

    try {
      const tempId = `probe_${roleMode}_${Date.now()}`;
      const sha = imageSha256 || `sha256_probe_${tempId}`;
      const composedLoc = composeCampusLocation(locationArea, locationDetail);
      const hasImageInput = Boolean(base64Image || previewUrl);

      const [recogSettled, embSettled] = await Promise.allSettled([
        fetch('/api/tasks/recognize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            taskId: `task_${tempId}`,
            itemId: tempId,
            idempotencyKey: `idem_${tempId}`,
            base64Image: base64Image || undefined,
            mimeType,
            imageUrl: previewUrl || undefined,
            title: title.trim(),
            description: description.trim(),
            userCategoryHint: campusCategory,
          }),
        }),
        hasImageInput
          ? getOrEncodeCachedEmbedding({
              sha256: sha,
              itemId: tempId,
              base64Image: base64Image || undefined,
              mimeType,
              imageUrl: previewUrl || undefined,
              title: title.trim(),
              description: description.trim(),
              categoryHint: campusCategory,
              colorHint: color || '未知',
            })
          : Promise.resolve(null),
      ]);

      const recogResp = recogSettled.status === 'fulfilled' ? recogSettled.value : null;
      const recogData = recogResp && recogResp.ok ? await recogResp.json() : {};
      const mappedCat: CampusCategory | undefined = recogData.mappedCampusCategory;

      // M1: Automatically apply recognised campusCategory to the form when recognition completes
      let finalCategory: CampusCategory = campusCategory;
      if (mappedCat && mappedCat !== 'unknown' && !userManuallySelectedCategory) {
        finalCategory = mappedCat;
        setCampusCategory(mappedCat);
      } else if (campusCategory === 'unknown') {
        finalCategory = mappedCat && mappedCat !== 'unknown' ? mappedCat : '数码电子';
        setCampusCategory(finalCategory);
      }

      const finalColor = color.trim() || recogData.color || '未知';
      if (!color.trim() && recogData.color && recogData.color !== '未知') {
        setColor(recogData.color);
      }
      const finalBrand = brand.trim() || recogData.brand || '';
      if (!brand.trim() && recogData.brand) {
        setBrand(recogData.brand);
      }
      const extractedKeywords: string[] = Array.isArray(recogData.keywords)
        ? recogData.keywords
        : [];

      const embRes = embSettled.status === 'fulfilled' ? embSettled.value : null;

      const virtualItem: LostFoundItem = {
        id: tempId,
        type: roleMode,
        title: title.trim(),
        description: description.trim(),
        campusCategory: finalCategory,
        rawModelClass: recogData.rawModelClass || 'object',
        color: finalColor,
        quantity: 1,
        brand: finalBrand,
        rewardAmount: roleMode === 'lost' ? rewardAmount : 0,
        locationArea,
        locationDetail: locationDetail.trim(),
        location: composedLoc,
        eventTime,
        conditionText: '正常',
        keywords: extractedKeywords,
        imageUrl: previewUrl,
        imageSha256: sha,
        embeddingId: embRes?.embedding?.id,
        status: 'matching',
        ownerUid: currentUser.uid,
        ownerName: currentUser.displayName,
        createdAt: new Date().toISOString(),
      };

      const oppositeItems = items.filter(
        (it) =>
          it.type !== roleMode &&
          it.status !== 'delisted' &&
          it.status !== 'returned'
      );

      const embByItemId = new Map<string, ImageEmbedding>();
      const embById = new Map<string, ImageEmbedding>(embeddings.map((e) => [e.id, e]));
      if (embRes?.embedding) {
        embById.set(embRes.embedding.id, embRes.embedding);
      }

      for (const it of oppositeItems) {
        if (it.embeddingId && embById.has(it.embeddingId)) {
          embByItemId.set(it.id, embById.get(it.embeddingId)!);
        }
      }
      if (embRes?.embedding) {
        embByItemId.set(virtualItem.id, embRes.embedding);
      }

      const recallAndRerank = executeThreeWayRecallAndRerank(
        virtualItem,
        oppositeItems,
        embByItemId,
        DEFAULT_MATCHING_CONFIG,
        'three_way_rerank'
      );

      const itemMap = new Map(oppositeItems.map((i) => [i.id, i]));
      // [B1] Filter smart-match results view strictly to totalScore >= 58.0 (decisionThreshold)
      const paired = recallAndRerank.matches
        .filter((ev) => ev.totalScore >= DEFAULT_MATCHING_CONFIG.decisionThreshold)
        .map((ev) => {
          const oppId = roleMode === 'lost' ? ev.foundItemId : ev.lostItemId;
          const oppItem = itemMap.get(oppId);
          return oppItem ? { evalResult: ev, targetItem: oppItem } : null;
        })
        .filter((x): x is { evalResult: EvaluatedCandidate; targetItem: LostFoundItem } =>
          Boolean(x)
        );

      setCandidateResults(paired);
      setHasSearched(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '匹配失败，请重试');
    } finally {
      clearTimeout(timer);
      setMatchingNow(false);
    }
  };

  const handleDirectPublishPost = async () => {
    if (publishingNow) return;
    if (publishedSuccessItem) {
      setErrorMsg('该帖子已发布成功，无需重复提交');
      return;
    }
    if (!title.trim() || !description.trim()) {
      setErrorMsg('请先填写物品名称和特征描述');
      return;
    }
    if (roleMode === 'lost' && rewardAmount > availableWalletBalance) {
      setErrorMsg(
        `悬赏金额（¥${rewardAmount}）超出当前钱包可用余额（¥${availableWalletBalance}），请调低悬赏金额后再发布`
      );
      return;
    }
    setPublishingNow(true);
    setErrorMsg(null);

    let publishTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const publishWorkflowPromise = (async () => {
        let finalImageUrl = previewUrl;
        let finalStoragePath = '';
        const stableItemId = draftItemId || `item_${roleMode}_${Date.now()}`;

        if (cleanBlob && imageSha256) {
          const up = await uploadCleanedImageToStorage(
            stableItemId,
            imageSha256,
            cleanBlob,
            previewUrl
          );
          finalImageUrl = up.imageUrl;
          finalStoragePath = up.storagePath;
        } else if (previewUrl) {
          finalStoragePath = `items/${imageSha256 || 'upload'}.jpg`;
        }

        const composedLoc = composeCampusLocation(locationArea, locationDetail);
        const result = await publishItemWithRecognitionWorkflow({
          draftItemId: stableItemId,
          userManuallySelectedCategory,
          type: roleMode,
          title: title.trim(),
          description: description.trim(),
          campusCategory,
          color: color.trim() || '未知',
          quantity: 1,
          brand: brand.trim(),
          rewardAmount: roleMode === 'lost' ? rewardAmount : 0,
          locationArea,
          locationDetail: locationDetail.trim(),
          location: composedLoc,
          eventTime,
          conditionText: '正常',
          verificationQuestion: verificationQuestion.trim() || undefined,
          imageUrl: finalImageUrl,
          storagePath: finalStoragePath,
          imageSha256: imageSha256 || undefined,
          base64Image: base64Image || undefined,
          mimeType,
          actor: currentUser,
        });

        // M1: Sync form's category dropdown with the recognised category applied to the published item
        if (result.item.campusCategory && result.item.campusCategory !== 'unknown') {
          setCampusCategory(result.item.campusCategory);
        }

        const matchRes = await runAndPersistMatchesForItem(
          result.item,
          [
            result.item,
            ...items.filter(
              (i) =>
                i.status !== 'delisted' &&
                i.status !== 'returned' &&
                i.id !== result.item.id
            ),
          ],
          embeddings,
          matches
        );

        // Requirement 6: If a high-score match (>= 58.0) is found on publish, also create a system notification message
        const topMatch = matchRes.updatedMatches.sort((a, b) => b.totalScore - a.totalScore)[0];
        if (topMatch && topMatch.totalScore >= DEFAULT_MATCHING_CONFIG.decisionThreshold) {
          const oppId =
            result.item.type === 'lost' ? topMatch.foundItemId : topMatch.lostItemId;
          const oppItem = items.find((i) => i.id === oppId);
          if (oppItem && oppItem.ownerUid !== currentUser.uid) {
            await sendInSiteMessage({
              itemId: oppItem.id,
              itemTitle: oppItem.title,
              content: `【系统匹配提醒】您新发布的《${result.item.title}》与《${oppItem.title}》匹配度达 ${topMatch.totalScore.toFixed(0)}%，请点击查看核对。`,
              actor: currentUser,
              receiverUid: oppItem.ownerUid,
            });
          }
        }

        await onDataMutated();
        setPublishedSuccessItem(result.item);
        onPublishedNewItem(result.item);
      })();

      const timeoutGuardPromise = new Promise<never>((_, reject) => {
        publishTimeoutHandle = setTimeout(() => {
          reject(new Error('发布请求响应超时（>20秒），请点击重试发布（已自动开启防重复创建保护）'));
        }, 20000);
      });

      await Promise.race([publishWorkflowPromise, timeoutGuardPromise]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '发布失败，请点击重试');
    } finally {
      if (publishTimeoutHandle) clearTimeout(publishTimeoutHandle);
      setPublishingNow(false);
    }
  };

  // ==================== STEP 0: XIANYU-STYLE TWO-OPTION CHOOSER SCREEN (参考上传截图1) ====================
  if (stepMode === 'chooser') {
    return (
      <div className="min-h-[78vh] flex flex-col justify-between bg-gradient-to-b from-[#FFFDF9] via-white to-[#F6F7FB] -mx-3.5 -mt-3 px-5 pt-10 pb-8">
        {/* Top Headline */}
        <div className="space-y-1.5 pt-2">
          <h1 className="text-2xl font-black tracking-tight text-slate-900">
            寻找失物 · 归还拾物
          </h1>
          <p className="text-xs text-slate-500">
            上传物品信息后先自动为您查找相似帖子，未找到可直接发布
          </p>
        </div>

        {/* Bottom Option Cards Area (Modeled after Xianyu's publish chooser screenshot) */}
        <div className="space-y-5 mt-auto">
          <div className="space-y-2.5">
            <div className="text-sm font-extrabold text-slate-900 px-0.5">请选择您要办理的事项</div>

            {/* Option 1: 我东西丢了 */}
            <button
              type="button"
              onClick={() => {
                setRoleMode('lost');
                setDraftItemId(`item_lost_${Date.now()}`);
                setEventTime(getCurrentLocalDateTimeValue());
                setPublishedSuccessItem(null);
                setUserManuallySelectedCategory(false);
                setErrorMsg(null);
                setHasSearched(false);
                setStepMode('form');
              }}
              className="w-full p-5 rounded-3xl bg-[#FFF6DF] hover:bg-[#FFEFCA] border border-orange-200/60 flex items-center gap-4 text-left transition-all cursor-pointer active:scale-[0.99] shadow-2xs"
            >
              <div className="w-12 h-12 rounded-2xl bg-[#FF8A00] text-white flex items-center justify-center shrink-0 shadow-xs">
                <Search className="w-6 h-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold text-slate-900">我东西丢了</div>
                <div className="text-xs text-slate-600 mt-0.5">
                  自动在拾物中寻找 · 支持添加悬赏金额发布寻物帖
                </div>
              </div>
            </button>

            {/* Option 2: 我捡到东西了 */}
            <button
              type="button"
              onClick={() => {
                setRoleMode('found');
                setDraftItemId(`item_found_${Date.now()}`);
                setEventTime(getCurrentLocalDateTimeValue());
                setPublishedSuccessItem(null);
                setUserManuallySelectedCategory(false);
                setErrorMsg(null);
                setHasSearched(false);
                setStepMode('form');
              }}
              className="w-full p-5 rounded-3xl bg-[#EEF6FF] hover:bg-[#E0EEFF] border border-blue-200/60 flex items-center gap-4 text-left transition-all cursor-pointer active:scale-[0.99] shadow-2xs"
            >
              <div className="w-12 h-12 rounded-2xl bg-[#1677FF] text-white flex items-center justify-center shrink-0 shadow-xs">
                <HandHeart className="w-6 h-6" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-base font-extrabold text-slate-900">我捡到东西了</div>
                <div className="text-xs text-slate-600 mt-0.5">
                  自动匹配焦急寻找的失主 · 或一键发布拾物招领帖
                </div>
              </div>
            </button>
          </div>

          {/* Close X Button at bottom center (matching Xianyu screenshot) */}
          {onClosePublishTab && (
            <div className="pt-2 flex justify-center">
              <button
                type="button"
                onClick={onClosePublishTab}
                aria-label="关闭发布页面"
                className="w-10 h-10 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center cursor-pointer transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ==================== STEP 1 & 2: FORMAL PUBLISH & SMART MATCH VIEW ====================
  return (
    <div className="space-y-3.5 pb-8">
      {/* Top Bar: Back to Chooser + Current Role Switch */}
      <div className="bg-white rounded-3xl p-3.5 shadow-2xs border border-slate-200/70 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setStepMode('chooser')}
          className="px-2.5 py-1.5 rounded-xl hover:bg-slate-100 text-xs font-bold text-slate-700 flex items-center gap-1 cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>重选类型</span>
        </button>

        <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-2xl">
          <button
            type="button"
            onClick={() => {
              setRoleMode('lost');
              setHasSearched(false);
            }}
            className={`px-3 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              roleMode === 'lost'
                ? 'bg-[#FF5000] text-white shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            我东西丢了
          </button>
          <button
            type="button"
            onClick={() => {
              setRoleMode('found');
              setHasSearched(false);
            }}
            className={`px-3 py-1 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              roleMode === 'found'
                ? 'bg-[#0066CC] text-white shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            我捡到东西了
          </button>
        </div>
      </div>

      {/* Main Formal Publish & Match Card */}
      <div className="bg-white rounded-3xl p-4 shadow-2xs border border-slate-200/80 space-y-4">
        <form onSubmit={handleRunSmartMatch} className="space-y-3.5">
          {/* Hidden File Inputs for Gallery & Camera */}
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            className="hidden"
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Single Image Upload Area -> Clicking opens prompt to pick from gallery or open camera */}
          <div className="p-3.5 rounded-2xl bg-slate-50 border border-dashed border-slate-300 flex items-center justify-between gap-3">
            {previewUrl ? (
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <img
                  src={previewUrl}
                  alt="物品图片"
                  className="w-16 h-16 rounded-xl object-cover border border-slate-200 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-bold text-slate-800">物品图片已添加</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    系统将自动识别图中物品外观以帮助寻找匹配
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-slate-600">
                <div className="font-bold text-slate-800">添加物品照片</div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  支持上传相册图片或直接拍照，更易找回物品
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowImageSourcePrompt(true)}
              className="px-3.5 py-2 rounded-xl bg-white border border-slate-200 hover:border-slate-300 text-xs font-bold text-slate-800 flex items-center gap-1.5 cursor-pointer shrink-0 shadow-2xs"
            >
              <Upload className="w-3.5 h-3.5 text-[#FF6B2C]" />
              <span>{previewUrl ? '更换图片' : '上传图片'}</span>
            </button>
          </div>

          {/* Basic Item Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">物品名称 *</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => {
                  if (title.trim()) {
                    void runQuickCategoryRecognition({ titleText: title });
                  }
                }}
                placeholder={
                  roleMode === 'lost' ? '请输入丢失的物品名称' : '请输入捡到的物品名称'
                }
                className="w-full px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:border-[#FF6B2C]"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">物品分类</label>
              <select
                value={campusCategory}
                onChange={(e) => {
                  setCampusCategory(e.target.value as CampusCategory);
                  setUserManuallySelectedCategory(true);
                }}
                className="w-full px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:border-[#FF6B2C]"
              >
                {CAMPUS_CATEGORIES.filter((c) => c.value !== 'unknown').map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">大体位置 *</label>
              <select
                value={locationArea}
                onChange={(e) => setLocationArea(e.target.value as CampusLocationArea)}
                className="w-full px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:border-[#FF6B2C]"
              >
                {CAMPUS_LOCATION_AREAS.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                详细位置（选填）
              </label>
              <input
                type="text"
                value={locationDetail}
                onChange={(e) => setLocationDetail(e.target.value)}
                placeholder={
                  locationArea === '宿舍楼' ? '如：6号楼一楼' : '如：四楼自习区 / 201教室'
                }
                className="w-full px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:border-[#FF6B2C]"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">颜色 / 品牌</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  placeholder="颜色（如白色）"
                  className="w-1/2 px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl"
                />
                <input
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder="品牌（选填）"
                  className="w-1/2 px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                {roleMode === 'lost' ? '丢失时间' : '拾获时间'}
              </label>
              <input
                type="datetime-local"
                value={eventTime}
                onChange={(e) => setEventTime(e.target.value)}
                className="w-full px-3 py-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-xl"
              />
            </div>
          </div>

          {/* Bounty Setting for Lost Items */}
          {roleMode === 'lost' && (
            <div className="p-3.5 rounded-2xl bg-orange-50/70 border border-orange-200/80 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-orange-950">悬赏酬谢（选填）</span>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-500">
                    钱包可用 ¥{availableWalletBalance}
                  </span>
                  <span className="text-xs font-extrabold text-[#FF5000]">
                    {rewardAmount > 0 ? `¥${rewardAmount}` : '无悬赏'}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[0, 10, 20, 50].map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => setRewardAmount(amt)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer ${
                      rewardAmount === amt
                        ? 'bg-[#FF5000] text-white'
                        : 'bg-white text-slate-700 border border-orange-200'
                    }`}
                  >
                    {amt === 0 ? '不设悬赏' : `¥${amt}`}
                  </button>
                ))}
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={rewardAmount || ''}
                  onChange={(e) =>
                    setRewardAmount(Math.max(0, Math.min(9999, Number(e.target.value) || 0)))
                  }
                  placeholder="其他金额"
                  className="w-24 px-2.5 py-1.5 text-xs font-mono bg-white border border-orange-200 rounded-xl ml-auto"
                />
              </div>
              {rewardAmount > availableWalletBalance && (
                <div className="text-[11px] font-semibold text-red-600">
                  悬赏金额超出当前钱包可用余额（¥{availableWalletBalance}），请调低金额
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">物品特征描述 *</label>
            <textarea
              rows={2}
              required
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                if (description.trim() || title.trim()) {
                  void runQuickCategoryRecognition({
                    titleText: title,
                    descText: description,
                  });
                }
              }}
              placeholder="请简单描述物品外观特征（如保护壳、贴纸、挂件等）..."
              className="w-full px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:border-[#FF6B2C]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              {roleMode === 'lost' ? '归还核验问题（选填）' : '认领核验问题（选填）'}
            </label>
            <input
              type="text"
              value={verificationQuestion}
              onChange={(e) => setVerificationQuestion(e.target.value)}
              placeholder={
                roleMode === 'lost'
                  ? '选填，如：电脑外壳贴纸是什么图案？（用于核实拾主手中的实物）'
                  : '选填，如：请说出校园卡尾号或钥匙扣挂件？（防止冒领）'
              }
              className="w-full px-3 py-2.5 text-xs bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:outline-none focus:border-[#FF6B2C]"
            />
          </div>

          {errorMsg && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{errorMsg}</span>
              </div>
              {!publishingNow && !matchingNow && title.trim() && description.trim() && (
                <button
                  type="button"
                  onClick={handleDirectPublishPost}
                  className="px-2.5 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold shrink-0 cursor-pointer"
                >
                  重试发布
                </button>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5 pt-1">
            <button
              type="submit"
              disabled={matchingNow || publishingNow}
              className="py-3 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer disabled:opacity-60"
            >
              {matchingNow ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-[#FF6B2C]" />
                  <span>正在查找相似物品...</span>
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 text-[#FF6B2C]" />
                  <span>先匹配已有{roleMode === 'lost' ? '拾物' : '失物'}</span>
                </>
              )}
            </button>

            <button
              type="button"
              disabled={publishingNow || matchingNow}
              onClick={handleDirectPublishPost}
              className="py-3 rounded-2xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer disabled:opacity-60"
            >
              {publishingNow ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>正在发布...</span>
                </>
              ) : (
                <>
                  <FilePlus2 className="w-4 h-4" />
                  <span>直接发布{roleMode === 'lost' ? '失物帖' : '拾物帖'}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Match Results Section */}
      {hasSearched && (
        <div className="bg-white rounded-3xl p-4 shadow-2xs border border-slate-200/80 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900">
              为您找到 {candidateResults.length} 条相似的
              {roleMode === 'lost' ? '拾物招领' : '失物求助'}
            </h2>
            <span className="text-[11px] text-slate-400">按相似度从高到低排列</span>
          </div>

          {candidateResults.length === 0 ? (
            <div className="py-6 text-center space-y-1.5">
              <div className="text-xs font-bold text-slate-700">
                暂时没有找到相似的{roleMode === 'lost' ? '拾物' : '失物'}帖子
              </div>
              <div className="text-[11px] text-slate-500">
                点击下方按钮发布帖子，后续有人上传匹配物品时会在「消息」中第一时间通知您
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              {candidateResults.map(({ evalResult, targetItem }) => (
                <div
                  key={targetItem.id}
                  className="p-3 rounded-2xl bg-slate-50 border border-slate-200/80 space-y-2.5"
                >
                  <div className="flex items-start gap-3">
                    <ResilientItemImage
                      src={targetItem.imageUrl}
                      alt={targetItem.title}
                      category={targetItem.campusCategory}
                      className="w-18 h-18 rounded-xl object-cover border border-slate-200 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                          匹配度 {evalResult.totalScore.toFixed(0)}%
                        </span>
                        {targetItem.type === 'lost' && (targetItem.rewardAmount || 0) > 0 && (
                          <span className="text-xs font-extrabold text-[#FF5000]">
                            悬赏 ¥{targetItem.rewardAmount}
                          </span>
                        )}
                      </div>

                      <h3 className="text-xs font-bold text-slate-900 line-clamp-1">
                        {targetItem.title}
                      </h3>

                      <div className="text-[11px] text-slate-500 flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                        <span className="truncate">{targetItem.location}</span>
                      </div>

                      <p className="text-[11px] text-slate-600 line-clamp-1">
                        {targetItem.description}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200/60">
                    <button
                      type="button"
                      onClick={() => onOpenItemDetail(targetItem)}
                      className="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 text-xs font-semibold cursor-pointer"
                    >
                      查看详情
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenChatForItem(targetItem.id)}
                      className="px-3 py-1.5 rounded-xl bg-[#FF6B2C] hover:bg-[#E85A1E] text-white text-xs font-bold flex items-center gap-1 cursor-pointer"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      <span>发私信联系</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Bottom Publish Confirmation */}
          <div className="pt-2 border-t border-slate-100">
            {publishedSuccessItem ? (
              <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center gap-2 text-xs text-emerald-900 font-bold">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>已成功发布：《{publishedSuccessItem.title}》</span>
              </div>
            ) : (
              <button
                type="button"
                disabled={publishingNow}
                onClick={handleDirectPublishPost}
                className="w-full py-3 rounded-2xl bg-[#FF5000] hover:bg-[#E04600] text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm cursor-pointer disabled:opacity-60"
              >
                <FilePlus2 className="w-4 h-4" />
                <span>
                  {candidateResults.length > 0
                    ? `以上都不是我的物品，直接发布${roleMode === 'lost' ? '失物帖' : '拾物帖'}`
                    : `立即发布为${roleMode === 'lost' ? '失物求助帖' : '拾物招领帖'}`}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ==================== SINGLE UPLOAD BUTTON PROMPT: GALLERY OR CAMERA ==================== */}
      {showImageSourcePrompt && (
        <div
          onClick={() => setShowImageSourcePrompt(false)}
          className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full max-w-sm rounded-t-3xl sm:rounded-3xl p-4 space-y-2.5 shadow-2xl"
          >
            <div className="text-center py-1 text-xs font-bold text-slate-500">
              请选择添加图片方式
            </div>

            <button
              type="button"
              onClick={() => {
                setShowImageSourcePrompt(false);
                galleryInputRef.current?.click();
              }}
              className="w-full py-3.5 px-4 rounded-2xl bg-slate-50 hover:bg-orange-50 text-slate-900 font-bold text-sm flex items-center justify-center gap-2.5 transition-colors cursor-pointer"
            >
              <ImageIcon className="w-5 h-5 text-[#FF6B2C]" />
              <span>从图库上传图片</span>
            </button>

            <button
              type="button"
              onClick={handleOpenCamera}
              className="w-full py-3.5 px-4 rounded-2xl bg-slate-50 hover:bg-blue-50 text-slate-900 font-bold text-sm flex items-center justify-center gap-2.5 transition-colors cursor-pointer"
            >
              <Camera className="w-5 h-5 text-[#0066CC]" />
              <span>打开摄像机拍照</span>
            </button>

            <button
              type="button"
              onClick={() => setShowImageSourcePrompt(false)}
              className="w-full py-3 rounded-2xl bg-white hover:bg-slate-100 text-slate-500 font-semibold text-xs cursor-pointer"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* ==================== LIVE CAMERA CAPTURE MODAL ==================== */}
      {isCameraModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center p-4">
          <div className="w-full max-w-sm bg-slate-900 rounded-3xl overflow-hidden border border-white/15 shadow-2xl">
            <div className="px-4 py-3 flex items-center justify-between text-white text-xs font-bold">
              <span>拍摄物品照片</span>
              <button
                type="button"
                onClick={() => {
                  stopCameraStream();
                  setIsCameraModalOpen(false);
                }}
                className="p-1 rounded-full hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <video
              ref={videoRef}
              playsInline
              muted
              className="w-full h-72 object-cover bg-black"
            />
            <div className="p-4 flex items-center justify-center">
              <button
                type="button"
                onClick={handleCapturePhotoFromVideo}
                className="px-6 py-2.5 rounded-full bg-[#FF6B2C] text-white text-xs font-bold flex items-center gap-2 shadow-lg cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                <span>拍照并使用图片</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
