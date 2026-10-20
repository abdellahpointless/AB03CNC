import React from 'react';
import type { RegionId, UpcomingCountry } from '../regions';

/**
 * Country flags drawn as SVG (flag emoji do not render on Windows).
 * Proportions follow the official flags, simplified for small sizes.
 */
export function Flag({ country, className = '', title }: { country: RegionId | UpcomingCountry['id']; className?: string; title?: string }) {
  if (country === 'tn') {
    return (
      <svg viewBox="0 0 1200 800" className={className} role="img" aria-label={title ?? 'Tunisia'}>
        <rect width="1200" height="800" fill="#E70013" />
        <circle cx="600" cy="400" r="200" fill="#fff" />
        <circle cx="600" cy="400" r="150" fill="#E70013" />
        <circle cx="640" cy="400" r="120" fill="#fff" />
        <polygon fill="#E70013" points="570,400 630.9,378.8 632.2,314.4 671.1,365.8 732.8,347.1 696,400 732.8,452.9 671.1,434.2 632.2,485.6 630.9,421.2" />
      </svg>
    );
  }
  if (country === 'tr') {
    return (
      <svg viewBox="0 0 1200 800" className={className} role="img" aria-label={title ?? 'Türkiye'}>
        <rect width="1200" height="800" fill="#E30A17" />
        <circle cx="300" cy="400" r="200" fill="#fff" />
        <circle cx="350" cy="400" r="160" fill="#E30A17" />
        <polygon fill="#fff" points="396,400 634.5,322.5 487.1,525.4 487.1,274.6 634.5,477.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 900 600" className={className} role="img" aria-label={title ?? 'Morocco'}>
      <rect width="900" height="600" fill="#C1272D" />
      <polygon
        points="450,153 536.4,418.9 310.2,254.6 589.8,254.6 363.6,418.9"
        fill="none"
        stroke="#006233"
        strokeWidth="24"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
