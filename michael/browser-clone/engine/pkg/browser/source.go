package browser

// Finding the SOURCE profile on a work PC.
//
// WHY THIS IS NOT DefaultProfilePath. That function answers "where would a
// browser put its profile if it were launched here, right now" — the right
// question when MOUNTING a profile on a virgin hosted PC, and the wrong one here.
// This half runs over the platform's run-command path, which may execute it as
// SYSTEM (there is no interactive session to run inside when the traveller has
// logged off), and under SYSTEM `%LOCALAPPDATA%` is the SERVICE's own profile:
//
//	C:\Windows\system32\config\systemprofile\AppData\Local\Google\Chrome\User Data
//
// which either does not exist or holds an empty profile. A state sync rooted
// there reports state_profile_missing on a machine whose real profile is full of
// history — a failure that is true about the directory and a lie about the
// machine, and which nothing in the log explains.
//
// So: find a profile that IS THERE, with real state in it, and say WHICH one was
// chosen. Ordering is by recency, not by who is asking, because the real user's
// profile is the one being written to every day — whether this process runs as
// that user, as SYSTEM, or as anything else.

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"spaceworker.browser-clone/pkg/types"
)

// ErrSourceProfileMissing is returned when no usable profile could be located.
// The caller reports it by name (wake.ReasonStateProfileMissing) — a missing
// profile is a configuration fact, never a crash.
var ErrSourceProfileMissing = errors.New("state_profile_missing")

// SourceProfile is a profile directory that EXISTS on this machine.
type SourceProfile struct {
	// Dir is the absolute path of the profile directory itself
	// (…/User Data/Default), which is what CollectStateFiles walks.
	Dir string
	// Name is the Chromium profile name — "Default", "Profile 1". It is the name
	// the manifest must carry, because the server keys the state cache by it: a
	// run that resolved Profile 1 while reporting Default would file that state
	// where the launch never looks.
	Name string
	// Root is the "User Data" directory containing it. Reported so a log can say
	// which tree was used without naming a user.
	Root string
}

// profileNameRe matches Chromium's own directory naming for a profile.
var profileNameRe = regexp.MustCompile(`^Profile \d+$`)

// ResolveSourceProfile locates the profile to carry.
//
//   - override, when given, is used as-is: an operator who names a directory is
//     obeyed, and a directory that is not there is a REFUSAL rather than a quiet
//     fallback to a different profile (the wrong profile's bookmarks filed under
//     the requested name is worse than no sync).
//   - profileName, when given, must match: the platform asks for the profile its
//     replica is keyed by.
//   - neither given: the most recently used real profile on the machine.
func ResolveSourceProfile(browserType, profileName, override string) (SourceProfile, error) {
	browserType = strings.ToLower(strings.TrimSpace(browserType))

	if dir := strings.TrimSpace(override); dir != "" {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return SourceProfile{}, ErrSourceProfileMissing
		}
		info, err := os.Stat(abs)
		if err != nil || !info.IsDir() {
			return SourceProfile{}, ErrSourceProfileMissing
		}
		// An operator may hand us either the profile directory or the User Data
		// root that holds it. Both are legitimate, and telling them apart is
		// cheaper than refusing one of them.
		if looksLikeProfileName(filepath.Base(abs)) && isUsableProfile(abs) {
			return SourceProfile{Dir: abs, Name: filepath.Base(abs), Root: filepath.Dir(abs)}, nil
		}
		return pickSourceProfile([]string{abs}, strings.TrimSpace(profileName))
	}

	if !types.IsBrowserType(browserType) {
		return SourceProfile{}, ErrSourceProfileMissing
	}
	dataDir := chromeDataDir(browserType)
	if dataDir == "" {
		return SourceProfile{}, ErrSourceProfileMissing
	}
	return pickSourceProfile(sourceRootCandidates(dataDir), strings.TrimSpace(profileName))
}

// sourceRootCandidates lists every "User Data" tree this process can see, the
// current-user one first. Only Windows has more than one in practice: the
// per-user trees live under C:\Users, and a file-level read of another user's
// profile is permitted to the account that installed us.
func sourceRootCandidates(dataDir string) []string {
	candidates := []string{}
	if root := osUserDataRoot(); root != "" {
		candidates = append(candidates, filepath.Join(root, dataDir))
	}
	if runtime.GOOS == "windows" {
		// AppData\Local holds Chromium's User Data; AppData\Roaming is included
		// because a roamed profile is still data a replica may legitimately need
		// on a machine configured that way.
		for _, base := range []string{"Local", "Roaming"} {
			pattern := filepath.Join(`C:\Users`, "*", "AppData", base, dataDir)
			if matches, err := filepath.Glob(pattern); err == nil {
				candidates = append(candidates, matches...)
			}
		}
	}
	return candidates
}

// pickSourceProfile chooses a profile from the roots given, by recency.
//
// Pure over its roots so the choice is testable without a Windows machine, and so
// the rule can be stated exactly: among every usable profile in every root — and
// restricted to profileName when one was requested — the one written to most
// recently wins. A profile that is not usable (no Preferences, no History) is not
// a candidate at all: carrying an empty profile would produce a replica that
// looks correct and contains nothing.
func pickSourceProfile(roots []string, profileName string) (SourceProfile, error) {
	type candidate struct {
		profile SourceProfile
		seen    time.Time
	}
	var found []candidate
	for _, root := range roots {
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			continue
		}
		for _, name := range profileNamesIn(root, profileName) {
			dir := filepath.Join(root, name)
			if !isUsableProfile(dir) {
				continue
			}
			found = append(found, candidate{
				profile: SourceProfile{Dir: dir, Name: name, Root: root},
				seen:    profileRecency(dir),
			})
		}
	}
	if len(found) == 0 {
		return SourceProfile{}, ErrSourceProfileMissing
	}
	// Newest first; ties broken by path so the result is deterministic rather
	// than dependent on directory-read order.
	sort.Slice(found, func(i, j int) bool {
		if found[i].seen.Equal(found[j].seen) {
			return found[i].profile.Dir < found[j].profile.Dir
		}
		return found[i].seen.After(found[j].seen)
	})
	return found[0].profile, nil
}

// profileNamesIn lists the profile directories to consider under one root.
//
// An explicitly requested name is the ONLY candidate — see ResolveSourceProfile.
// Otherwise Default is tried first and, only when it is not usable, the other
// profile directories are read from the root. Chrome always has a Default, so the
// scan is the unusual case (a machine whose only profile was renamed, or a fork
// that starts at Profile 1).
func profileNamesIn(root, profileName string) []string {
	if profileName != "" {
		return []string{profileName}
	}
	if isUsableProfile(filepath.Join(root, "Default")) {
		return []string{"Default"}
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() || !looksLikeProfileName(e.Name()) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

// looksLikeProfileName is Chromium's own naming for a profile directory.
func looksLikeProfileName(name string) bool {
	return strings.EqualFold(name, "Default") || profileNameRe.MatchString(name)
}

// isUsableProfile is true when a directory holds a profile with state in it.
//
// The marker files are the ones every Chromium fork writes on first run:
// `Preferences` is created even by a browser that was launched once, and `History`
// only by one that was actually used. Either is enough — a profile that has been
// opened but never browsed still has settings worth carrying — but SOMETHING must
// be present, because an empty directory with the right name is not a profile.
func isUsableProfile(dir string) bool {
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	for _, marker := range []string{"Preferences", "History", "Cookies", "Bookmarks"} {
		if st, err := os.Stat(filepath.Join(dir, marker)); err == nil && !st.IsDir() {
			return true
		}
	}
	return false
}

// profileRecency is how recently a profile was written to, for the ordering.
//
// The DIRECT entries are inspected rather than the directory's own mtime: Chrome
// writes Preferences, History and its journals directly into the profile, so
// their newest timestamp moves with real use, while a directory's mtime can sit
// unchanged for as long as nobody adds a file at its top level.
func profileRecency(dir string) time.Time {
	newest := time.Time{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return newest
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	if newest.IsZero() {
		if info, err := os.Stat(dir); err == nil {
			newest = info.ModTime()
		}
	}
	return newest
}
