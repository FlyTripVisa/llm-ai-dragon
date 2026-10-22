/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");

// Chat state
let chatHistory = [
	{
		role: "assistant",
		content:
			"Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?",
	},
];
let isProcessing = false;

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

/**
 * Check whether user is near the bottom of the chat.
 * If so, we auto-scroll on updates. Otherwise we leave them alone.
 */
function isNearBottom() {
	const threshold = 80;
	return (
		chatMessages.scrollHeight -
			chatMessages.scrollTop -
			chatMessages.clientHeight <
		threshold
	);
}

function scrollToBottom(force = false) {
	if (force || isNearBottom()) {
		chatMessages.scrollTop = chatMessages.scrollHeight;
	}
}

/**
 * Escape HTML so user/LLM content can't break the DOM or run scripts.
 */
function escapeHtml(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Very small markdown-lite renderer for assistant messages:
 * code fences, inline code, bold, italic, and line breaks.
 * Returns HTML-safe output.
 */
function renderMarkdownLite(text) {
	// Split on triple-backtick code blocks first
	const parts = [];
	const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
	let lastIndex = 0;
	let match;

	while ((match = codeBlockRegex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			parts.push({
				type: "text",
				content: text.slice(lastIndex, match.index),
			});
		}
		parts.push({
			type: "code",
			lang: match[1] || "",
			content: match[2],
		});
		lastIndex = codeBlockRegex.lastIndex;
	}
	if (lastIndex < text.length) {
		parts.push({ type: "text", content: text.slice(lastIndex) });
	}

	let html = "";
	for (const part of parts) {
		if (part.type === "code") {
			html += `<pre><code>${escapeHtml(part.content)}</code></pre>`;
		} else {
			let t = escapeHtml(part.content);
			// Inline code
			t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
			// Bold
			t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			// Italic
			t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
			// Line breaks
			t = t.replace(/\n/g, "<br>");
			html += t;
		}
	}
	return html;
}

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
	const message = userInput.value.trim();

	// Don't send empty messages
	if (message === "" || isProcessing) return;

	// Disable input while processing
	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	// Add user message to chat
	addMessageToChat("user", message);

	// Clear input
	userInput.value = "";
	userInput.style.height = "auto";

	// Show typing indicator
	typingIndicator.classList.add("visible");

	// Add message to history
	chatHistory.push({ role: "user", content: message });

	let assistantMessageEl = null;
	let assistantTextEl = null;

	try {
		// Create new assistant response element
		assistantMessageEl = document.createElement("div");
		assistantMessageEl.className = "message assistant-message";
		assistantMessageEl.innerHTML = "<p></p>";
		chatMessages.appendChild(assistantMessageEl);
		assistantTextEl = assistantMessageEl.querySelector("p");

		scrollToBottom(true);

		// Send request to API
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: chatHistory,
			}),
		});

		// Handle errors
		if (!response.ok) {
			throw new Error(`Failed to get response (HTTP ${response.status})`);
		}
		if (!response.body) {
			throw new Error("Response body is null");
		}

		// Process streaming response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let responseText = "";
		let buffer = "";
		let sawDone = false;

		const flushAssistantText = () => {
			assistantTextEl.innerHTML = renderMarkdownLite(responseText);
			scrollToBottom();
		};

		// Consume one batch of SSE events (used in both streaming and final-flush paths)
		const consumeEvents = (events) => {
			for (const data of events) {
				if (data === "[DONE]") {
					sawDone = true;
					continue;
				}
				try {
					const jsonData = JSON.parse(data);
					// Handle both Workers AI format (response) and OpenAI format (choices[0].delta.content)
					let content = "";
					if (
						typeof jsonData.response === "string" &&
						jsonData.response.length > 0
					) {
						content = jsonData.response;
					} else if (jsonData.choices?.[0]?.delta?.content) {
						content = jsonData.choices[0].delta.content;
					}
					if (content) {
						responseText += content;
						flushAssistantText();
					}
				} catch (e) {
					console.error("Error parsing SSE data as JSON:", e, data);
				}
			}
		};

		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				// Process any remaining complete events in buffer
				const parsed = consumeSseEvents(buffer + "\n\n");
				consumeEvents(parsed.events);
				break;
			}

			// Decode chunk
			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;
			consumeEvents(parsed.events);

			if (sawDone) {
				break;
			}
		}

		// If nothing came back, show a friendly message rather than a blank bubble
		if (responseText.length === 0) {
			responseText = "(No response received from the model.)";
			flushAssistantText();
		}

		// Add completed response to chat history
		chatHistory.push({ role: "assistant", content: responseText });
	} catch (error) {
		console.error("Error:", error);

		// Remove the empty assistant bubble we created so the UI stays clean
		if (assistantMessageEl && assistantMessageEl.parentNode) {
			assistantMessageEl.parentNode.removeChild(assistantMessageEl);
		}

		// Do not persist the failed turn in history
		addMessageToChat(
			"assistant",
			"Sorry, there was an error processing your request. Please try again.",
		);
	} finally {
		// Hide typing indicator
		typingIndicator.classList.remove("visible");

		// Re-enable input
		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;

	const p = document.createElement("p");
	if (role === "assistant") {
		p.innerHTML = renderMarkdownLite(content);
	} else {
		// User input is rendered as plain text — never trust it as HTML
		p.textContent = content;
	}

	messageEl.appendChild(p);
	chatMessages.appendChild(messageEl);
	scrollToBottom(true);
}

/**
 * Parse an SSE buffer into complete events.
 * Returns the parsed events plus any remaining partial buffer.
 */
function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const lines = rawEvent.split("\n");
		const dataLines = [];
		for (const line of lines) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}