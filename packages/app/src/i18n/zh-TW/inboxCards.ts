// zh-TW wording for ../en/inboxCards.ts (same keys). Term choices are listed at the top of ../zh-TW.ts.
import type { EnglishKey } from '../en';

export const inboxCards: Partial<Record<EnglishKey, string>> = {
  // Shared by most Inbox cards.
  'inboxCards.dismiss': '關閉',
  'inboxCards.open': '開啟',
  'inboxCards.send': '傳送',
  'inboxCards.notNow': '稍後再說',
  'inboxCards.lookFirst': '先看看',
  'inboxCards.endsIn': '如果沒有回答，會在{time}後結束。',
  'inboxCards.details': '詳細資訊',
  'inboxCards.hideDetails': '隱藏詳細資訊',
  'inboxCards.showDetails': '顯示詳細資訊',
  'inboxCards.moreOptions': '更多選項',
  'inboxCards.labelled': '{label}：{text}',
  'inboxCards.agent': 'AI 助理',
  'inboxCards.runs': '執行：',

  // QuestionCard
  'inboxCards.verb.Write': '寫入',
  'inboxCards.verb.Edit': '編輯',
  'inboxCards.verb.Run': '執行指令',
  'inboxCards.verb.Read': '讀取',
  'inboxCards.verb.Delete': '刪除',
  'inboxCards.verb.Move': '移動',
  'inboxCards.verb.Fetch': '擷取',
  'inboxCards.verb.Search': '搜尋',
  'inboxCards.verb.mcp': '使用 {tool} 工具',
  'inboxCards.question.gap': ' ',
  'inboxCards.question.alwaysUse': '一律使用這個',
  'inboxCards.question.wants': '{who} 想要{action}',
  'inboxCards.question.orType': '或輸入回答',
  'inboxCards.question.typeAnswer': '輸入回答',
  'inboxCards.question.yourAnswer': '你的回答',

  // StuckCard
  'inboxCards.stuck.hint': '給它提示',
  'inboxCards.stuck.stallTitle': 'AI 助理 {name} 已 {n} 分鐘沒有進展。',
  'inboxCards.stuck.stallLine': '已 {n} 分鐘沒有進展。',
  'inboxCards.stuck.interrupt': '中斷',
  'inboxCards.stuck.askAnother': '問其他 AI 助理',

  // PaneApprovalCard and ApprovalPrompt
  'inboxCards.approval.waiting': '正在等你回答',
  'inboxCards.approval.ariaLabel': '核准要求',
  'inboxCards.failed': '這個回答沒有送到 AI 助理。請再試一次，或開啟終端機。',
  'inboxCards.openTerminal': '開啟終端機',
  'inboxCards.stalled': '剛才的回答沒有送出去，Claude 還在等。請再按一次你的回答。',

  // ConsentCard
  'inboxCards.consent.anotherAgent': '另一個 AI 助理',
  'inboxCards.consent.unknownAgent': '不明的 AI 助理',
  'inboxCards.consent.askedFromCommand': '它是從自己視窗裡的指令提出的。',
  'inboxCards.consent.askedThroughTools': '{who}透過自己的工具提出了這個要求。',
  'inboxCards.consent.notStarted': '這個 AI 助理不是它啟動的。',
  'inboxCards.consent.wantsToAnswer': '它想回答：「{asked}」。',
  'inboxCards.consent.controlTitle': '要允許{who}控制{target}嗎？',
  'inboxCards.consent.changeTitle': '要允許{who}變更{target}嗎？',
  'inboxCards.consent.answerTitle': '要允許{who}回答{target}中的問題嗎？',
  'inboxCards.consent.thatWindow': '那個視窗',
  'inboxCards.consent.deny': '拒絕',
  'inboxCards.consent.allowOnce': '允許一次',
  'inboxCards.consent.alwaysHere': '在這裡一律允許',
  'inboxCards.consent.commandTitle': '{who}想在背景執行一個指令：{target}',
  'inboxCards.consent.allowChat': '這個對話一律允許',
  'inboxCards.consent.no': '不要',

  // LimitCard
  'inboxCards.limit.otherAgent': '其他 AI 助理…',
  'inboxCards.limit.startAs': '以 {label} 啟動 {name}',
  'inboxCards.limit.thisAgent': '這個 AI 助理',
  'inboxCards.limit.wakeOn': '喚醒 {name} 的時間…',

  // IssueCard
  'inboxCards.issue.header': 'GitHub issue',
  'inboxCards.issue.headerNumber': 'GitHub issue #{n}',
  'inboxCards.issue.byLine': '由 {labeler} 加上標籤 · 由 {writer} 撰寫',
  'inboxCards.issue.held': 'Potato Workspace 不會推送這項變更。請自行檢查副本。',
  'inboxCards.issue.openDraft': '建立草稿 PR',
  'inboxCards.issue.throwAway': '捨棄',
  'inboxCards.issue.ignore': '忽略這個 issue',
  'inboxCards.issue.startFallback': '開始執行',
  'inboxCards.issue.showText': '顯示 issue 內容',
  'inboxCards.issue.hideText': '隱藏 issue 內容',
  'inboxCards.issue.textLabel': 'AI 助理會收到的文字',

  // CiFixCard
  'inboxCards.ci.failed': 'CI 失敗',
  'inboxCards.ci.failedOn': '#{n} 的 CI 失敗了。',
  'inboxCards.ci.fix': 'CI 修正',
  'inboxCards.ci.try': '第 {n} 次，共 {total} 次',
  'inboxCards.ci.logSize': '紀錄：{size}',
  'inboxCards.ci.snapshot': '來自儲存的檔案副本',
  'inboxCards.ci.logFailed': '無法載入紀錄。',
  'inboxCards.ci.logLoading': '正在載入紀錄…',
  'inboxCards.ci.logGone': '紀錄已經不在了。這次修正已結束。',
  'inboxCards.ci.noLines': '這項檢查沒有保留任何紀錄。',
  'inboxCards.ci.logLabel': 'AI 助理會收到的紀錄',
  'inboxCards.ci.failingChecks': '未通過的檢查',
  'inboxCards.ci.fixFallback': '請 AI 助理修正',
  'inboxCards.ci.push': '推送修正',
  'inboxCards.ci.dontPush': '不要推送',
  'inboxCards.ci.stopWatching': '不再追蹤這個 PR',
  'inboxCards.ci.showLog': '顯示紀錄',
  'inboxCards.ci.hideLog': '隱藏紀錄',
  'inboxCards.ci.held': 'Potato Workspace 不會推送這項修正。請自行檢查副本。',

  // AskNotices
  'inboxCards.ask.title': '{agent} 的回答',
  'inboxCards.ask.noAnswer': 'AI 助理無法回答。',
  'inboxCards.ask.listLabel': 'AI 助理的回答',

  // HiddenRuns
  'inboxCards.hidden.title': '{name} 這個 AI 助理在沒有視窗的情況下執行過',
  'inboxCards.hidden.listLabel': '在沒有視窗的情況下執行過的 AI 助理',

  // ImportChatsCard
  'inboxCards.import.title': '把對話帶過來',
  'inboxCards.import.body': '把其他 AI 助理留在這台電腦上的對話匯入進來。資料不會離開這台電腦。',
  'inboxCards.import.bring': '匯入我的對話',
  'inboxCards.import.listLabel': '舊對話',

  // CanaryNotices
  'inboxCards.canary.listLabel': 'AI 助理的相關通知',

  // lib/attention-copy.ts (the phone card and its queue)
  'inboxCards.attention.changed': '這個問題有變動，請再看一次。',
  'inboxCards.attention.gone': '這個問題已經不在了。{agent} 已繼續進行。',
  'inboxCards.attention.alreadyPc': '已在電腦上回答：{label}。',
  'inboxCards.attention.alreadyYou': '你已經回答過：{label}。',
  'inboxCards.attention.alreadyPhone': '已從 {device} 回答：{label}。',
  'inboxCards.attention.answered': '{label} · {clock} · 從這支手機',
  'inboxCards.attention.failed': '無法把你的回答傳給 {agent}。沒有輸入任何內容。',
  'inboxCards.attention.offline': '連不上你的電腦。你的回答沒有送出。',
  'inboxCards.attention.lost': '電腦沒有回應。你的回答可能沒有送達。',
  'inboxCards.attention.sending': '傳送中',
  'inboxCards.attention.sendingToPc': '正在傳送到你的電腦',
  'inboxCards.attention.stillSending': '還在傳送中，你的電腦尚未確認。',
  'inboxCards.attention.watchOnly': '這支手機只能查看。想在這裡回答，請到電腦上允許：連線 › 手機。',
  'inboxCards.attention.controlOnly': '這支手機無法執行這個動作。請到電腦上允許：連線 › 手機。',
  'inboxCards.attention.provenanceScreen': '從畫面讀取',
  'inboxCards.attention.caution': '允許之前請先看清楚，之後可能很難復原。',
  'inboxCards.attention.noPromptTitle': '{agent} 正在等你',
  'inboxCards.attention.noPromptBody': 'Potato Workspace 讀不到這個問題。請開啟 AI 助理回答。',
  'inboxCards.attention.signInTitle': '{agent} 需要你到電腦前處理。',
  'inboxCards.attention.signInBody': '它正顯示登入畫面。Potato Workspace 不會替你回答。',
  'inboxCards.attention.expired': '{agent} 已在 {clock} 停止等待。',
  'inboxCards.attention.queue_one': '還有 {count} 個在等',
  'inboxCards.attention.queue_other': '還有 {count} 個在等',
  'inboxCards.attention.emptyTitle': '沒有需要你處理的事',
  'inboxCards.attention.emptyBody': 'AI 助理停下來問你時，會顯示在這裡。',
  'inboxCards.attention.dealtWith': '這個要求已經處理過了。',
  'inboxCards.attention.openPane': '開啟 AI 助理',
  'inboxCards.attention.tryAgain': '再試一次',
  'inboxCards.attention.lookAgain': '再看一次',
  'inboxCards.attention.answeredWord': '已回答',
  'inboxCards.attention.anotherPhone': '另一支手機',
  'inboxCards.attention.theAgent': 'AI 助理',

  // Time words in the cards (lib/attention-copy.ts)
  'inboxCards.age.justNow': '剛剛',
  'inboxCards.age.minutes': '{n} 分鐘',
  'inboxCards.age.hours': '{n} 小時',
  'inboxCards.age.hoursMinutes': '{h} 小時 {m} 分鐘',
  'inboxCards.age.seconds': '{n} 秒',

  // Missions (the progress view's timeline row)
  'inboxCards.mission.openAgent': '開啟 AI 助理',

  // A risky ask of a minion, docked in the chat of the agent that started it
  'inboxCards.minionAsks': '{parent} 的小代理想問',
  'inboxCards.openMinion': '看看它在做什麼',

  // The jump-out card over the work area (a blocking question that only the Inbox shows)
  'inboxCards.jumpOut.region': '現在需要你',
  'inboxCards.jumpOut.later': '稍後',
  'inboxCards.jumpOut.show': '展開',
  'inboxCards.jumpOut.laterTip': '先收起來，它仍會留在收件匣。',
  'inboxCards.jumpOut.more': '收件匣還有 {n} 個 >',
};
