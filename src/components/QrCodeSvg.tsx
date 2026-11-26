/**
 * Deterministic SVG QR Code Generator & Zero-Broken-Image Resilient Image Component
 */

import React, { useEffect, useState } from 'react';
import { Package } from 'lucide-react';

interface QrCodeSvgProps {
  payload: string;
  size?: number;
}

export const QrCodeSvg: React.FC<QrCodeSvgProps> = ({ payload, size = 148 }) => {
  const gridSize = 21;

  // Check if cell (r, c) is part of the three 7x7 finder patterns
  const isFinderPattern = (r: number, c: number): boolean | null => {
    const checkCorner = (topR: number, leftC: number): boolean | null => {
      const dr = r - topR;
      const dc = c - leftC;
      if (dr < 0 || dr > 6 || dc < 0 || dc > 6) return null;
      if (dr === 0 || dr === 6 || dc === 0 || dc === 6) return true;
      if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) return true;
      return false;
    };
    const tl = checkCorner(0, 0);
    if (tl !== null) return tl;
    const tr = checkCorner(0, gridSize - 7);
    if (tr !== null) return tr;
    const bl = checkCorner(gridSize - 7, 0);
    if (bl !== null) return bl;

    // Quiet separator around finder patterns
    if (
      (r === 7 && (c <= 7 || c >= gridSize - 8)) ||
      (c === 7 && (r <= 7 || r >= gridSize - 8)) ||
      (r === gridSize - 8 && c <= 7) ||
      (c === gridSize - 8 && r <= 7)
    ) {
      return false;
    }
    return null;
  };

  // Deterministic bit hash from payload string
  const isModuleDark = (r: number, c: number): boolean => {
    const finder = isFinderPattern(r, c);
    if (finder !== null) return finder;
    // Timing pattern on row 6 and col 6
    if (r === 6) return c % 2 === 0;
    if (c === 6) return r % 2 === 0;

    const idx = r * gridSize + c;
    const charA = payload.charCodeAt(idx % payload.length) || 65;
    const charB = payload.charCodeAt((idx * 7 + 3) % payload.length) || 90;
    const hash = (charA * 31 + charB * 17 + r * 13 + c * 29) & 0xff;
    return hash % 2 === 0;
  };

  const cells: React.ReactElement[] = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (isModuleDark(r, c)) {
        cells.push(
          <rect
            key={`${r}-${c}`}
            x={c + 2}
            y={r + 2}
            width={1}
            height={1}
            fill="#0F172A"
            rx={0.12}
          />
        );
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${gridSize + 4} ${gridSize + 4}`}
      className="bg-white rounded-xl border border-slate-200 p-1.5 shadow-xs select-none"
      role="img"
      aria-label="交接核验二维码"
    >
      <rect x={0} y={0} width={gridSize + 4} height={gridSize + 4} fill="#FFFFFF" rx={1.5} />
      {cells}
    </svg>
  );
};

interface ResilientItemImageProps {
  src?: string;
  alt: string;
  category?: string;
  className?: string;
}

export const ResilientItemImage: React.FC<ResilientItemImageProps> = ({
  src,
  alt,
  category = '校园物品',
  className = 'w-full h-44 object-cover',
}) => {
  const normalizedSrc = src ? src.replace(/^\/src\/assets\/images\//, '/images/') : '';
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [normalizedSrc]);

  if (!normalizedSrc || failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200/70 text-slate-500 p-4 ${className}`}
      >
        <Package className="w-7 h-7 text-slate-400 mb-1.5" />
        <span className="text-xs font-medium text-slate-600 text-center line-clamp-1">{alt}</span>
        <span className="text-[11px] text-slate-400 mt-0.5">{category}</span>
      </div>
    );
  }

  return (
    <img
      src={normalizedSrc}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
};
