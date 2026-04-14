import { type HTMLAttributes } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

export function Card({ hover = false, className = '', children, ...props }: CardProps) {
  return (
    <div
      className={`
        rounded-lg border border-[var(--border)]
        bg-[var(--bg-raised)] p-4
        ${hover ? 'transition-colors hover:bg-[var(--bg-hover)] cursor-pointer' : ''}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
}
