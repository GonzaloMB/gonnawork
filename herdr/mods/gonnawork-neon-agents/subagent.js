// The window a Claude Code sub-agent opens in when its row is clicked. It runs inside its
// parent's process, so it has no terminal to go to; Claude Code writes its transcript as it
// goes, and this follows it (transcript.py): the prompt, every tool call with its answer,
// what it says, and its report to the parent.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, ScrollHandle } from "gpui-base";
import { exec, run, theme, settings, closeOverlay, appHome } from "herdr";

const RED = "#ff453a";
const PREVIEW = 420; // chars of a prompt shown before More

function clipText(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const at = cut.lastIndexOf(" ");
  return (at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

function elapsed(started, until) {
  const t = Date.parse(started ?? "");
  if (!t) return null;
  const m = Math.max(0, Math.round(((until ?? Date.now()) - t) / 60000));
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export class SubagentWindow {
  // p: { log, root, title, type }; overlay: this window's id.
  constructor(p, overlay, cx) {
    this.p = p;
    this.overlay = overlay;
    this.data = null;
    this.error = null;
    this.follow = true;
    this.toBottom = true;
    this.open = new Set();
    this.busy = false;
    this.scroll = ScrollHandle.new();
    this.load(cx);
    // A finished transcript doesn't change: stop reading it.
    cx.timer.every(1500, (cx) => { if (!this.data || this.data.running) this.load(cx); });
  }

  load(cx) {
    if (this.busy || !this.p?.log) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        const r = await exec("python3", [appHome() + "/mods/gonnawork-neon-agents/transcript.py", this.p.log, String(this.data?.mtime ?? 0)], { timeout: 15000 });
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
        const d = JSON.parse(r.stdout);
        if (d.missing) {
          changed = this.error === null;
          this.error = "Transcript not found: Claude Code may have cleaned it up";
        } else if (!d.same) {
          if (this.follow && (d.items?.length ?? 0) !== (this.data?.items?.length ?? 0)) this.toBottom = true;
          this.data = d;
          this.error = null;
          changed = true;
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
        changed = true;
      }
      this.busy = false;
      if (changed) cx.notify();
    });
  }

  button(t, id, label, color, action) {
    return div().id(id).h(24).px(8).flex().flex_none().items_center().rounded(6).border_1().border_color(t.border)
      .text_size(11.5).text_color(color ?? t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(label);
  }

  // A prompt or a message sent to it: long ones fold.
  sent(t, it, i, label) {
    const open = this.open.has(i);
    const long = it.text.length > PREVIEW;
    return v_flex().id(`it-${i}`).flex_none().p(10).gap(5).rounded(8).bg(t.raised).border_1().border_color(t.border)
      .when(long, (el) => el.cursor_pointer().on_click((_e, cx) => { open ? this.open.delete(i) : this.open.add(i); cx.notify(); }))
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(10).font_semibold().text_color(t.dim).child(label))
        .child(div().flex_1())
        .when(long, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(open ? "Less" : "More"))))
      .child(div().text_size(12).text_color(t.muted).child(TextView.markdown(`md-${i}-${open}`, open || !long ? it.text : clipText(it.text, PREVIEW))));
  }

  tool(t, it, i, mono) {
    const answered = it.res !== undefined;
    return v_flex().id(`it-${i}`).flex_none().gap(2).min_w(0)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(div().flex_none().font_family(mono).text_size(11).text_color(it.err ? RED : t.accent).child(it.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(it.summary || "")))
      .when(answered, (el) => el.child(h_flex().gap(6).min_w(0)
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("↳"))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(10.5).text_color(it.err ? RED : t.dim)
          .child(`${it.res} line${it.res === 1 ? "" : "s"}${it.first ? ` · ${it.first}` : ""}`))));
  }

  item(t, it, i, mono) {
    if (it.k === "prompt") return this.sent(t, it, i, "PROMPT");
    if (it.k === "msg") return this.sent(t, it, i, "MESSAGE");
    if (it.k === "tool") return this.tool(t, it, i, mono);
    if (it.k === "result") return v_flex().id(`it-${i}`).flex_none().p(10).gap(5).rounded(8).border_1().border_color(t.done + "66").bg(t.done + "12")
      .child(div().text_size(10).font_semibold().text_color(t.done).child("REPORT TO PARENT"))
      .child(div().text_size(12.5).child(TextView.markdown(`md-${i}`, it.text)));
    return div().id(`it-${i}`).flex_none().text_size(12.5).child(TextView.markdown(`md-${i}`, it.text));
  }

  render(_cx) {
    const t = theme();
    const d = this.data;
    const mono = settings().font_family || "JetBrains Mono";
    const running = d ? d.running : true;
    const finished = Boolean(d?.finished);
    const until = running ? null : (d?.mtime ?? 0) * 1000 || null;
    const facts = [d?.type || this.p.type, d?.model?.replace(/^claude-/, ""), d ? `${d.tools} tool${d.tools === 1 ? "" : "s"}` : null,
      elapsed(d?.started, until), d && !running ? (finished ? "finished" : "stopped") : null].filter(Boolean).join(" · ");
    const status = running
      ? svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900)
      : div().size(8).mx(2).flex_none().rounded(4).bg(finished ? t.done : t.dim);

    const items = d?.items ?? [];
    const children = [];
    items.forEach((it, i) => {
      children.push(this.item(t, it, i, mono));
      if (i === 0 && it.k === "prompt" && d.dropped) children.push(div().flex_none().text_size(10.5).text_color(t.dim).child(`${d.dropped} earlier steps not shown`));
    });
    if (!d && !this.error) children.push(div().py(24).flex().justify_center().text_size(12).text_color(t.dim).child("Reading transcript…"));
    if (d && running) children.push(h_flex().flex_none().gap(6).items_center().text_size(11).text_color(t.dim)
      .child(div().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child("Working"));
    if (this.toBottom && children.length) { this.scroll.scroll_to_item(children.length - 1); this.toBottom = false; }

    return v_flex().size_full().min_h(0).text_color(t.foreground).text_size(13)
      .child(h_flex().h(46).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(status)
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().font_semibold().child(d?.description || this.p.title || "Sub-agent"))
          .child(div().truncate().text_size(11).text_color(t.dim).child(facts || "Claude Code sub-agent")))
        .when(running, (el) => el.child(this.button(t, "sub-follow", this.follow ? "Following" : "Follow", this.follow ? t.working : null, (cx) => {
          this.follow = !this.follow;
          if (this.follow) this.toBottom = true;
          cx.notify();
        })))
        .child(this.button(t, "sub-parent", "Parent", null, () => run("agent.focus", { terminal: this.p.root })))
        .child(this.button(t, "sub-close", "×", null, () => closeOverlay(this.overlay))))
      .when(Boolean(this.error), (el) => el.child(div().mx(12).mt(8).px(8).py(5).rounded(6).bg(RED + "14").text_size(11).text_color(RED).child(this.error)))
      .child(v_flex().id("sub-body").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).px(14).py(12).gap(10).children(children));
  }
}
