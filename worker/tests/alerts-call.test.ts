import { describe, expect, it } from 'vitest';
import { callFailed, callReplyText } from '../alerts';

const page = (body: string) =>
  `<html><head><script async src="https://www.googletagmanager.com/gtag/js?id=UA-1"></script><script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag("js", new Date()); gtag("config", "UA-149177385-1"); if (x) console.error("error");</script><style>.error{color:red}</style></head><body>${body}</body></html>`;

describe('CallMeBot reply', () => {
  it('keeps only the visible text', () => {
    expect(callReplyText(page('<p>Call to @abdellah queued.<br>Text: Test</p>'))).toBe('Call to @abdellah queued. Text: Test');
  });
  it('is not fooled by "error" inside scripts or styles', () => {
    expect(callFailed(callReplyText(page('<p>Call to @abdellah queued.</p>')))).toBe(false);
  });
  it('recognises a user who has not authorised CallMeBot', () => {
    const t = callReplyText(page('<p>User not authorized. <a href="#">Click here to authorize CallMeBot to contact you.</a></p>'));
    expect(callFailed(t)).toBe(true);
    expect(t).toContain('User not authorized');
  });
});
