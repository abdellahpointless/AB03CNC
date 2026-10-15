import React from 'react';

interface IconProps {
  size?: number | string;
  className?: string;
}

export const DrillIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 2H10a1 1 0 0 0-1 1v7h6V3a1 1 0 0 0-1-1z" />
    <path d="M9 10v8l3 4 3-4v-8H9z" />
    <path d="M9 12c1.5 1 4.5 2 6 3" />
    <path d="M9 15c1.5 1 4.5 2 6 3" />
    <path d="M12 10v12" strokeWidth="0.5" strokeDasharray="2 2" />
  </svg>
);

export const EndMillIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 2H10a1 1 0 0 0-1 1v8h6V3a1 1 0 0 0-1-1z" />
    <path d="M9 11v11h6V11H9z" />
    <path d="M11 11v11" />
    <path d="M13 11v11" />
    <path d="M9 14l6-2" />
    <path d="M9 18l6-2" />
    <path d="M9 22l6-2" />
  </svg>
);

export const RoughingEndMillIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 2H10a1 1 0 0 0-1 1v8h6V3a1 1 0 0 0-1-1z" />
    <path d="M9 11v11h6V11H9z" />
    <path d="M11 11v11" />
    <path d="M13 11v11" />
    <path d="M8 13h8" strokeWidth="1.5" />
    <path d="M8 15h8" strokeWidth="1.5" />
    <path d="M8 17h8" strokeWidth="1.5" />
    <path d="M8 19h8" strokeWidth="1.5" />
    <path d="M8 21h8" strokeWidth="1.5" />
  </svg>
);

export const BallNoseIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 2H10a1 1 0 0 0-1 1v8h6V3a1 1 0 0 0-1-1z" />
    <path d="M9 11v8a3 3 0 0 0 6 0v-8H9z" />
    <path d="M12 11v11" />
    <path d="M9 14c1.5 1 4.5 1 6 0" />
    <path d="M9 17c1.5 1 4.5 1 6 0" />
  </svg>
);

export const ChamferIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14 2H10a1 1 0 0 0-1 1v11h6V3a1 1 0 0 0-1-1z" />
    <path d="M9 14l3 5 3-5H9z" />
  </svg>
);

export const CenterDrillIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M13 2h-2a1 1 0 0 0-1 1v9h4V3a1 1 0 0 0-1-1z" />
    <path d="M9 12l2 4v6h2v-6l2-4H9z" />
    <path d="M11 16h2" />
    <path d="M11 18h2" />
    <path d="M11 20h2" />
  </svg>
);

export const FaceMillIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M13 2h-2a1 1 0 0 0-1 1v9h4V3a1 1 0 0 0-1-1z" />
    <path d="M5 12h14v6H5z" />
    <path d="M6 18l1.5 4h1L10 18" />
    <path d="M14 18l1.5 4h1L18 18" />
    <path d="M9 12v6" />
    <path d="M15 12v6" />
  </svg>
);

export const TapIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M13 2h-2a1 1 0 0 0-1 1v7h4V3a1 1 0 0 0-1-1z" />
    <path d="M10 10v10l1 2h2l1-2V10h-4z" />
    <path d="M9 11h6" />
    <path d="M9 13h6" />
    <path d="M9 15h6" />
    <path d="M9 17h6" />
    <path d="M9 19h6" />
  </svg>
);

export const EmptyIcon = ({ size = 24, className = "" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} strokeDasharray="4 4" opacity={0.3}>
    <circle cx="12" cy="12" r="10" />
  </svg>
);
