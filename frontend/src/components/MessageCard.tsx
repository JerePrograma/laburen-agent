"use client";

import clsx from "clsx";
import type { ReactNode } from "react";

export type MessageKind = "user" | "assistant" | "tool" | "thought" | "error";

interface Props {
  kind: MessageKind;
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  streaming?: boolean;
}

export function MessageCard({ kind, title, meta, children, streaming }: Props) {
  return (
    <div className={clsx("message-card", kind, streaming && "streaming")}> 
      <div className="meta">
        <strong>{title}</strong>
        {meta}
      </div>
      <div className="content">{children}</div>
    </div>
  );
}
