дава# Todo List

## 🐛 Bug: Age calculation with death date ✅
- [x] Fix `Models.add()` in db.js — use `calcAgeAtDeath` when date_of_death is set (already done)
- [x] Fix `Models.update()` in db.js — same (already done)
- [x] Fix `Models.recalcAll()` in db.js — same (already done)
- [x] Fix `renderDetail` in app.js — show "умерла в N лет" / "Возраст на момент смерти" for deceased

## ✨ Feature: Crop window enhancement
- [x] Modify `openCropper()` — default to full frame (autoCropArea: 1.0) ✅ already done
- [x] Add "Продолжить без изменений" button in cropper ✅ already done
- [ ] Auto-open cropper when selecting a photo file (via `<input type="file">`)
- [ ] Auto-open cropper when entering a URL (via `promptPhotoUrl`)

## ✨ Feature: Photo source tracking + URL optimization
- [x] Add `_photo_meta` field to track URL vs upload source per photo ✅ already done
- [x] Modify `promptPhotoUrl` to mark photo as "url" source ✅ already done
- [x] Modify `setMainPhoto`/`setBppPhoto` to accept source param ✅ already done
- [x] Update `openCropper` to mark result as "upload" source ✅ already done
- [x] Update save flow: don't upload URL-sourced photos again ✅ already done (processPhotoForSave)
- [x] Add visual indicator showing source (🔗 external URL / 📦 bucket) ✅ already done

## ✨ Feature: UI indicator of photo source
- [x] Add CSS for source indicator badges ✅ already done
- [x] Show badge in detail view, edit form, and card ✅ already done