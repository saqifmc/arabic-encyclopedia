# My Arabic Encyclopedia

A simple personal Arabic vocabulary and revision website designed for GitHub Pages.

## Files
- `index.html` — website structure
- `style.css` — design and Arabic RTL styling
- `script.js` — search, filters and flashcards
- `vocab.json` — your vocabulary and speaking phrases

## How to add new vocabulary
Open `vocab.json` and add a new object inside the `vocabulary` list.

Example:

```json
{
  "arabic": "كَتَبَ",
  "english": "to write",
  "root": "ك ت ب",
  "type": "Verb",
  "form": "I",
  "past": "كَتَبَ",
  "present": "يَكْتُبُ",
  "masdar": "كِتَابَةٌ",
  "topic": "Study",
  "source": "Lesson",
  "example": "كَتَبَ الطَّالِبُ الدَّرْسَ.",
  "example_en": "The student wrote the lesson.",
  "status": "Learning"
}
```

## Publish on GitHub Pages
1. Create a new public repository on GitHub.
2. Upload all five files in this folder.
3. Open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Choose the `main` branch and `/ (root)`.
6. Save.

GitHub will provide the live site address.
