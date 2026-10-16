---
theme: default
title: CNC Process Pro - How it works
info: Short training for the production team
colorSchema: dark
transition: fade
routerMode: hash
fonts:
  sans: Inter
  mono: JetBrains Mono
layout: cover
class: cover
---

<div class="logo">//</div>

# CNC Process Pro

<p class="sub">How the app works, in 10 minutes</p>

<div class="pill">For operators and production team</div>

<!--
Welcome. This is a short tour of the app you use to prepare programs for the machines.
No technical knowledge is needed.
-->

---
layout: center
class: text-center
---

# What does the app do for you?

<div class="grid grid-cols-3 gap-6 mt-10 text-left">
  <div class="card" v-click>
    <div class="ico">🔧</div>
    <h3>Right tools</h3>
    <p>It changes the tool numbers in a program to the tools that are <b>really in your machine</b>.</p>
  </div>
  <div class="card" v-click>
    <div class="ico">🛡️</div>
    <h3>Safer machining</h3>
    <p>It warns you about tools that are too short and brings the <b>table to you</b> when you must turn the part.</p>
  </div>
  <div class="card" v-click>
    <div class="ico">📦</div>
    <h3>Parts counted</h3>
    <p>Parts made <b>without a scan</b> are recorded and counted for you every month.</p>
  </div>
</div>

<!--
Three jobs: correct tools, safety, and counting parts.
-->

---
layout: two-cols
class: gap-10
---

# 1. Sign in

<div class="steps">

1. Open the app on the workshop PC
2. Type **your own** username and password
3. Press **Sign In**

</div>

<div class="note mt-8" v-click>
🔑 Change your password with the <b>key</b> button at the top right.<br/>
Never share your password: everything you do is saved under your name.
</div>

::right::

<img src="/shots/01-login-crop.png" class="shot side" />

---

# 2. The main screen

<img src="/shots/02-home.png" class="shot big" />

<div class="legend">
  <span><b>Top bar</b> connection status · time saved · your name · sign out</span>
  <span><b>Tabs</b> Tool Inventory · Tool Remapper · Recent Codes · Part without scan</span>
</div>

<!--
The top bar shows if you are connected (green "Synced").
The tabs are the four places you will use.
-->

---
layout: section
---

# Prepare a program
<p class="sub">Tool Remapper - 5 steps</p>

---
layout: two-cols
class: gap-10
---

# Step 1 · Load

<div class="steps">

1. Choose the **machine** (e.g. HAAS-1)
2. **Paste** the program, or press **Import** to open the file
3. Press **Analyze & Remap**

</div>

<div class="note good mt-6" v-click>
✅ The app checks the program as soon as you paste it.<br/>
A green bar tells you what it already fixed.
</div>

::right::

<img src="/shots/03-pasted-crop.png" class="shot side" />

---

# Step 2 · Check the tools

<div class="grid grid-cols-5 gap-8 items-start">
<img src="/shots/04-resolution-crop.png" class="shot col-span-3" />

<div class="col-span-2 mt-2 space-y-4">
  <div class="tag red">Missing tool</div>
  <p>The tool is not in the machine. <b>Choose a tool</b> from the list, or create a new one.</p>
  <div class="tag orange">Approximate</div>
  <p>A close tool was chosen. <b>Check it</b> is OK for the job.</p>
  <div class="tag green">Resolved</div>
  <p>The tool is OK.</p>
</div>
</div>

<!--
Red must be fixed before you can continue. Orange means look carefully.
-->

---
layout: two-cols
class: gap-10
---

# Step 3 · Confirm

<div class="steps">

1. When all tools are set, press **Apply & Generate Code**
2. If a tool is **too short**, a red warning appears: stop and check
3. Read the warning and press **Confirm & Generate**

</div>

<div class="note warn mt-6">
⚠️ The app helps, but <b>you</b> make the final check.<br/>
The tools in the machine must match the program.
</div>

::right::

<img src="/shots/06-confirm-crop.png" class="shot side" />

---

# Step 4 · Read the result

<img src="/shots/07b-generated-end.png" class="shot big" />

<div class="legend">
  <span><b class="g">Green</b> line changed by the app</span>
  <span><b class="o">Orange</b> approximate tool: check it</span>
  <span><b>Left</b> original program · <b>Right</b> new program</span>
</div>

---
layout: two-cols
class: gap-10
---

# Step 5 · Extract the code

<div class="steps">

1. Press **Extract Code** (orange button)
2. The file downloads, ready for the machine
3. It is saved in **Recent Codes** automatically

</div>

<div class="note mt-6" v-click>
📶 No internet? You can still extract.<br/>
The top bar shows <b>"1 to upload"</b> and it sends the record when the connection is back.
</div>

::right::

<img src="/shots/08-extracted-crop.png" class="shot side" />

---
layout: center
---

# The table comes to you 🛡️

<p class="sub text-center">The app adds <code>G53 Y0</code> only where you need the table close</p>

<div class="grid grid-cols-2 gap-10 mt-8">
<div class="card">
<h3>🔄 When you turn the part</h3>

```txt {4}
N16 T13 M6
N17 (MESSERKOPF D93 ...)
N18 (DIAMETER 93.00 MM ...)
N19 G53 Y0
N20 M0 (TEIL 180 GRAD ...)
N22 G52 X-50. Y50. Z-10.5
```
<p>Before the stop (M0) of a part flip (G52).</p>
</div>
<div class="card">
<h3>📦 At the end of the program</h3>

```txt {3}
N31 G00 Z50.
N32 M05
N33 G53 Y0
N34 M30
```
<p>Before M30, so you can take the parts out.</p>
</div>
</div>

<p class="text-center mt-6 dim">No more stretching to reach the table. If the line is already there, nothing is added.</p>

<!--
This is the most important safety change.
The table comes to the operator only when needed: before the part is turned, and at the end.
Normal tool changes are not touched.
-->

---
layout: section
---

# The other tabs

---
layout: two-cols
class: gap-10
---

# Tool Inventory

<div class="steps">

- All tools of each machine: **number, type, diameter, length**
- Click a tool to see or edit it
- An **orange** tool was changed by someone: click it to say "seen"

</div>

<div class="note mt-6">
🔁 A change made on one PC appears on all PCs within ~15 seconds.
</div>

::right::

<img src="/shots/10-tools-crop.png" class="shot side" />

---
layout: two-cols
class: gap-10
---

# Recent Codes

<div class="steps">

- Every program you extracted
- **Search** by file name or tool number
- Press **Export** to download it again

</div>

::right::

<img src="/shots/11-recent-crop.png" class="shot side" />

---
layout: two-cols
class: gap-10
---

# Part without scan

<div class="steps">

1. Type the **SAP number**
2. Type the **quantity**
3. Choose **Produced part** (1 point) or **Modification** (0.5 point)
4. Press **Submit Part Entry**

</div>

<div class="note mt-6" v-click>
🕒 Your entry is <b>pending</b> until the chief approves it.<br/>
Then it is added to <b>This month's counter</b>.
</div>

::right::

<img src="/shots/13-part-form-crop.png" class="shot side" />

---

# How a part entry is counted

<div class="flow mt-16">
  <div class="step" v-click="1"><div class="num">1</div>You submit<br/><small>SAP + quantity</small></div>
  <div class="arrow" v-click="2">→</div>
  <div class="step orange" v-click="2"><div class="num">2</div>Pending<br/><small>waiting for review</small></div>
  <div class="arrow" v-click="3">→</div>
  <div class="step green" v-click="3"><div class="num">3</div>Approved<br/><small>by the chief</small></div>
  <div class="arrow" v-click="4">→</div>
  <div class="step blue" v-click="4"><div class="num">4</div>Counted<br/><small>in your month</small></div>
</div>

<p class="text-center mt-14 dim">A rejected entry is not counted. Ask your chief if you don't know why.</p>

---
layout: two-cols
class: gap-10
---

# The top bar

<div class="status">
  <div><span class="dot green"></span><b>Synced</b> all good</div>
  <div><span class="dot orange"></span><b>1 to upload</b> waiting for internet, keep working</div>
  <div><span class="dot orange"></span><b>Offline</b> no connection, the app still works with the last tools</div>
</div>

<div class="note mt-8">
🌙☀️ The <b>moon / sun</b> button switches between dark and light screen.
</div>

::right::

<img src="/shots/09-sync-crop.png" class="shot side" />

---
layout: center
---

# Remember

<div class="grid grid-cols-2 gap-6 mt-8 text-left">
  <div class="card good" v-click>✅ Sign in with <b>your own</b> account</div>
  <div class="card good" v-click>✅ Always <b>check the tools</b> in the machine</div>
  <div class="card warn" v-click>⚠️ Red warning = <b>stop and check</b> the tool length</div>
  <div class="card good" v-click>✅ Extract the code from the app, not by hand</div>
  <div class="card good" v-click>✅ Enter parts without scan <b>the same day</b></div>
  <div class="card warn" v-click>⚠️ Something looks wrong? <b>Ask before running</b></div>
</div>

---
layout: cover
class: cover
---

<div class="logo">//</div>

# Questions?

<p class="sub">Thank you. Safe and good work 👷</p>
