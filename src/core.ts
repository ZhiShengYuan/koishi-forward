import { Context, h, Universal } from 'koishi'
import { RuleSource, RuleTarget, Config } from './config'

// Extend the Koishi database schema
declare module 'koishi' {
  interface Tables {
    myrtus_forward_sent: Sent
  }
}

interface Sent {
  from: string
  to: string
  from_sid: string
  to_sid: string
  from_channel_id: string
  to_channel_id: string
  time: Date
  id?: number
}

//
// ─── HELPER FUNCTION TO TRANSFORM / DROP CERTAIN ELEMENT TYPES ─────────────────────────
//

/**
 * transform() wraps `h.transform` but explicitly drops any <image> elements.
 * Text, <at>, <face>, <audio>, etc. are preserved or converted to simple text.
 * You can add additional rules inside the second argument if you need to override more tags.
 */
function transform(source: h[], rules?: h.SyncVisitor<never>): h[] {
  return h.transform(source, {
    // Drop all <image> tags by returning null
    image(attrs) {
      return null
    },
    // Copy/paste your existing visitors for @, face, audio, etc.
    at(attrs) {
      const name = attrs.name || attrs.id
      return h.text(`@${name}`)
    },
    face(attrs) {
      const name = attrs.name || '表情'
      return h.text(`[${name}]`)
    },
    audio(attrs) {
      return h.text('[语音]')
    },
    // Merge in any extra rules you passed in
    ...rules
  })
}

//
// ─── APPLY PLUGIN ───────────────────────────────────────────────────────────────────────
//

export function apply(ctx: Context, config: Config) {
  // 1) Extend database table
  ctx.model.extend('myrtus_forward_sent', {
    id: 'unsigned',
    time: 'timestamp',
    from: 'string(64)',
    to: 'string(64)',
    from_sid: 'string(64)',
    to_sid: 'string(64)',
    from_channel_id: 'string(64)',
    to_channel_id: 'string(64)',
  }, {
    autoInc: true,
  })

  const { logger } = ctx

  // 2) For each forwarding rule in your config...
  for (const rule of config.rules) {
    const sConfig = config.constants[rule.source] as RuleSource
    if (!sConfig) continue

    const targetConfigs: RuleTarget[] = []
    for (const target of rule.targets) {
      const targetConfig = config.constants[target] as RuleTarget
      if (targetConfig && !targetConfig.disabled) {
        targetConfigs.push(targetConfig)
      }
    }
    if (!targetConfigs.length) continue

    // 3) Build a listener for the source bot/channel
    let listened = ctx.platform(sConfig.platform)
    if (sConfig.selfId !== '*') listened = listened.self(sConfig.selfId)
    if (sConfig.channelId !== '*') listened = listened.channel(sConfig.channelId)

    listened.on('message-created', async (session) => {
      const { event, sid } = session

      // ─── BLOCK IF ANY “blockingWords” APPEAR IN THE RAW TEXT ─────────────────────
      for (const regexpStr of sConfig.blockingWords) {
        const reg = new RegExp(regexpStr)
        const hit = session.elements.some(v => v.type === 'text' && reg.test(v.attrs.content))
        if (hit) return
      }

      // ─── RETRIEVE ANY PAST “Sent” ROWS IF THIS IS A QUOTE REPLY ──────────────────────
      let rows: Sent[] = []
      const { quote } = event.message
      let quoteUser: Universal.User
      if (quote) {
        // Fetch the quoted‐message user (might need a getMessage)
        quoteUser = quote.user ?? (await session.bot.getMessage(session.channelId, quote.id)).user

        if (event.selfId === quoteUser.id) {
          // If the source BOT itself was quoted, fetch rows where “to” was that message
          rows = await ctx.database.get('myrtus_forward_sent', {
            to: quote.id,
            to_sid: sid,
            to_channel_id: event.channel.id,
          })
          if (sConfig.onlyQuote && !rows.length) {
            return
          }
        } else if (sConfig.onlyQuote) {
          // If user is not quoting the bot and “onlyQuote”=true, skip
          return
        } else {
          // Otherwise, fetch rows where “from” was that quoted‐message ID
          rows = await ctx.database.get('myrtus_forward_sent', {
            from: quote.id,
            from_sid: sid,
            from_channel_id: event.channel.id,
          })
        }

        logger.debug('%C', '=== inspect quote ===')
        logger.debug(`from sid: ${sid}`)
      } else if (sConfig.onlyQuote) {
        // If “onlyQuote”=true but there is no quote, bail out
        return
      }

      // ─── STEP A: DROP IMAGES & CONVERT EMOJI/AT/AUDIO → PLAIN TEXT ───────────────────
      const filteredElements = transform(event.message.elements, {
        // If “onlyQuote” is enabled, drop any @tags that reference our own BOT
        at(attrs) {
          if (sConfig.onlyQuote && attrs.id === event.selfId) {
            return h.text('')
          }
          const name = attrs.name || attrs.id
          return h.text(`@${name}`)
        }
      })

      // On Discord, also append any embed‐title or embed‐description as text
      if (session.platform === 'discord') {
        for (const embed of (session.event as any)._data.d.embeds) {
          const buffer: string[] = []
          if (embed.title) buffer.push(embed.title)
          if (embed.description) buffer.push(embed.description)
          if (buffer.length) {
            filteredElements.push(h.text(buffer.join('\n')))
          }
        }
      }

      // ─── STEP B: FLATTEN “filteredElements” INTO A SINGLE PLAIN‐TEXT STRING ───────────
      // We will send only pure text (no images) to the censor‐service.
      const plainText = filteredElements
        .map(node => node.type === 'text' ? node.attrs.content : '')
        .join('')

      // If there's nothing left after dropping images (e.g. it was only an image message), skip forwarding entirely
      if (!plainText.trim()) {
        return
      }

      // ─── STEP C: SEND TO LOCAL CENSOR SERVICE WITH 500ms TIMEOUT ────────────────────
      let finalText = plainText
      try {
        // Use AbortController to enforce 500ms timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 500)

        const payload = {
          from: session.userId,
          ctx: event.channel.id,
          context: plainText,
        }

        const response = await fetch('http://127.0.0.1:41356', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        clearTimeout(timeoutId)

        if (response.ok) {
          const data = await response.json().catch(() => null)
          if (data && typeof data.context === 'string') {
            finalText = data.context
          }
        }
      } catch (err) {
        // Either fetch was aborted (timeout) or connection failure → fall back to plainText
        logger.warn('Censor service unreachable or timed out, sending original text.')
      }

      // ─── STEP D: FOR EACH TARGET BOT, RECONSTRUCT PAYLOAD AND FORWARD ─────────────
      const sentRows: Sent[] = []

      for (let index = 0; index < targetConfigs.length; index++) {
        const target = targetConfigs[index]
        const targetSid = `${target.platform}:${target.selfId}`
        const bot = ctx.bots[targetSid]

        if (!bot) {
          logger.warn(`暂时找不到机器人实例 %c, 等待一会儿说不定就有了呢!`, targetSid)
          continue
        }
        if (bot.status !== Universal.Status.ONLINE) {
          logger.warn(`机器人实例 %c 处于非在线状态，可能与网络环境有关。`, targetSid)
          continue
        }

        // ── BUILD “prefix” (simulate original author if requested) ─────────────────
        let prefix: h
        if (target.simulateOriginal && target.platform === 'discord') {
          // If we want to simulate the original Discord embed style:
          let avatar = event.user.avatar
          if (event.platform === 'telegram') {
            // Telegram users have no Discord avatar URL; pick a default
            avatar = 'https://discord.com/assets/5d6a5e9d7d77ac29116e.png'
          }
          prefix = h('author', {
            name: `[${sConfig.name ?? ''}] ${session.username}`,
            avatar,
          })
        } else {
          // Otherwise just prepend “[<sourceName> – <username>]”
          const altName = sConfig.name ? `${sConfig.name} - ` : ''
          prefix = h.text(`[${altName}${session.username}]\n`)
        }

        // Insert a small delay between each target’s send, if needed
        const delay = config.delay[target.platform] ?? 200
        if (index) {
          await ctx.sleep(delay)
        }

        // ── REBUILD “payload” AS prefix + censored/timeout‐fallback text ─────────────
        const payload: h[] = [
          prefix,
          h.text(finalText),
        ]

        // ── IF THE ORIGINAL MESSAGE WAS A QUOTE, TRY PRESERVING THE QUOTE CHAIN ───────
        if (event.message.quote) {
          let quoteId: string | undefined

          if (event.selfId === quoteUser.id) {
            // If the quoted message was our own BOT, look for the matching “from→to” row
            const row = rows.find(v =>
              v.from_sid === targetSid &&
              v.from_channel_id === target.channelId
            )
            if (row) {
              quoteId = row.from
            }
          } else {
            // Otherwise, find the matching “to→from” row
            const row = rows.find(v =>
              v.to_sid === targetSid &&
              v.to_channel_id === target.channelId
            )
            if (row) {
              quoteId = row.to
            }
          }

          if (quoteId) {
            // If we found a matching message ID in the database, insert h.quote(quoteId)
            if (payload[0].type === 'author') {
              payload.splice(1, 0, h.quote(quoteId))
            } else {
              payload.unshift(h.quote(quoteId))
            }
          } else {
            // If no matching row, just prepend a textual “Re <username> ⌈ … ⌋”
            const { user: qUser, elements = [], member } = event.message.quote
            const name = member?.nick || qUser.nick || qUser.name
            payload.unshift(
              h.text(`Re ${name} ⌈`),
              ...transform(elements),
              h.text('⌋\n')
            )
          }
        }

        // ── SEND THE MESSAGE TO THE TARGET BOT ─────────────────────────────────────
        try {
          const messageIds = await bot.sendMessage(target.channelId, payload)
          for (const msgId of messageIds) {
            sentRows.push({
              from: event.message.id,
              from_sid: `${event.platform}:${event.selfId}`,
              to: msgId,
              to_sid: targetSid,
              from_channel_id: event.channel.id,
              to_channel_id: target.channelId,
              time: new Date(),
            })
          }
        } catch (error) {
          logger.error(error)
        }
      }

      // 4) UPSERT ALL “sent” RECORDS INTO THE DATABASE
      if (sentRows.length) {
        await ctx.database.upsert('myrtus_forward_sent', sentRows)
      }
    })
  }
}
