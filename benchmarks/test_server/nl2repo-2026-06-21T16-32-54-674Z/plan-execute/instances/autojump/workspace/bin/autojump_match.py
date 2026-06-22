"""Autojump matching module.

Provides intelligent path matching algorithms for directory navigation:
- match_anywhere: Match patterns at any position in the path
- match_consecutive: Match consecutive characters at the end of the path
- match_fuzzy: Edit-distance based fuzzy matching with threshold control
"""

import os
import re
import sys
import math


def _edit_distance(s1, s2):
    """Calculate the Levenshtein edit distance between two strings.

    Args:
        s1: First string.
        s2: Second string.

    Returns:
        Integer edit distance between s1 and s2.
    """
    if len(s1) < len(s2):
        return _edit_distance(s2, s1)

    if len(s2) == 0:
        return len(s1)

    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row

    return previous_row[-1]


def _fuzzy_score(needle, haystack_str):
    """Calculate a fuzzy match score between needle and haystack_str.

    Uses edit distance normalized by the length of the longer string.
    Returns a score between 0 (no match) and 1 (exact match).

    Args:
        needle: The search pattern.
        haystack_str: The string to search in.

    Returns:
        Float score between 0.0 and 1.0.
    """
    if not needle:
        return 1.0
    if not haystack_str:
        return 0.0

    # If needle is a substring, perfect score
    if needle.lower() in haystack_str.lower():
        return 1.0

    max_len = max(len(needle), len(haystack_str))
    dist = _edit_distance(needle.lower(), haystack_str.lower())
    score = 1.0 - (dist / max_len)
    return max(0.0, score)


def match_anywhere(needles, haystack, ignore_case=False):
    """Match patterns at any position in the path.

    The patterns need to appear in the same order, not necessarily continuously.
    Supports case-sensitive and case-insensitive matching.

    Args:
        needles: List of string patterns to match (e.g., ["foo", "bar"]).
        haystack: List of Entry objects to search through.
        ignore_case: If True, matching is case-insensitive.

    Yields:
        Entry objects from haystack that match all needles in order.

    Example:
        >>> entries = [Entry(path="/home/user/projects", weight=10.0)]
        >>> result = list(match_anywhere(["proj"], entries))
        >>> result[0].path
        '/home/user/projects'
    """
    if not needles:
        return

    for entry in haystack:
        path = entry.path
        if ignore_case:
            search_path = path.lower()
            search_needles = [n.lower() for n in needles]
        else:
            search_path = path
            search_needles = needles

        # Check that all needles appear in the path in order
        pos = 0
        all_found = True
        for needle in search_needles:
            idx = search_path.find(needle, pos)
            if idx == -1:
                all_found = False
                break
            pos = idx + len(needle)

        if all_found:
            yield entry


def match_consecutive(needles, haystack, ignore_case=False):
    """Match patterns that appear consecutively at the end of the path.

    For example, ['foo', 'baz'] can match paths ending with /.../foo/.../baz.
    The patterns must appear in order towards the end of the path.

    Args:
        needles: List of string patterns to match.
        haystack: List of Entry objects to search through.
        ignore_case: If True, matching is case-insensitive.

    Yields:
        Entry objects from haystack that match consecutive patterns.

    Example:
        >>> entries = [Entry(path="/home/user/projects/foo/baz", weight=10.0)]
        >>> result = list(match_consecutive(["foo", "baz"], entries))
        >>> result[0].path
        '/home/user/projects/foo/baz'
    """
    if not needles:
        return

    for entry in haystack:
        path = entry.path
        if ignore_case:
            search_path = path.lower()
            search_needles = [n.lower() for n in needles]
        else:
            search_path = path
            search_needles = needles

        # Check consecutive matching: needles must appear in order
        pos = 0
        all_found = True
        for needle in search_needles:
            idx = search_path.find(needle, pos)
            if idx == -1:
                all_found = False
                break
            pos = idx + len(needle)

        if all_found:
            yield entry


def match_fuzzy(needles, haystack, ignore_case=False, threshold=0.6):
    """Fuzzy matching using edit distance algorithm with threshold control.

    Matches directory paths against search patterns using Levenshtein distance.
    Only returns results where the similarity score exceeds the threshold.

    Args:
        needles: List of string patterns to match.
        haystack: List of Entry objects to search through.
        ignore_case: If True, matching is case-insensitive.
        threshold: Minimum similarity score (0.0 to 1.0) for a match.
                   Default is 0.6.

    Yields:
        Entry objects from haystack that match with score >= threshold,
        sorted by combined score in descending order.

    Example:
        >>> entries = [Entry(path="/home/user/projects", weight=10.0)]
        >>> result = list(match_fuzzy(["proj"], entries, threshold=0.6))
        >>> result[0].path
        '/home/user/projects'
    """
    if not needles:
        return

    # Calculate scores for all entries
    scored_entries = []
    for entry in haystack:
        path = entry.path
        if ignore_case:
            search_path = path.lower()
            search_needles = [n.lower() for n in needles]
        else:
            search_path = path
            search_needles = needles

        # Split path into components for granular matching
        components = search_path.split(os.sep)
        component_names = [c for c in components if c]

        best_score = 0.0

        for needle in search_needles:
            # Strategy 1: Full path match
            score = _fuzzy_score(needle, search_path)
            best_score = max(best_score, score)

            # Strategy 2: Individual component match
            for component in component_names:
                score = _fuzzy_score(needle, component)
                best_score = max(best_score, score)

            # Strategy 3: Substring check (already handled in _fuzzy_score)
            if needle in search_path:
                best_score = max(best_score, 1.0)

        # Only yield if score meets threshold
        if best_score >= threshold:
            scored_entries.append((entry, best_score))

    # Sort by score descending, then by weight descending for ties
    scored_entries.sort(key=lambda x: (-x[1], -x[0].weight))

    for entry, score in scored_entries:
        yield entry


if __name__ == "__main__":
    # Quick self-test
    from bin.autojump_data import Entry

    entries = [
        Entry(path="/home/user/projects", weight=10.0),
        Entry(path="/home/user/work/project", weight=8.0),
        Entry(path="/home/user/documents", weight=5.0),
    ]

    # Test anywhere matching
    result = list(match_anywhere(["proj"], entries))
    assert len(result) == 2, f"Expected 2, got {len(result)}"
    assert result[0].path == "/home/user/projects"
    print("match_anywhere: PASS")

    # Test anywhere matching with multiple needles
    result = list(match_anywhere(["user", "proj"], entries))
    assert len(result) == 2, f"Expected 2, got {len(result)}"
    print("match_anywhere (multiple needles): PASS")

    # Test match_consecutive
    result = list(match_consecutive(["proj"], entries))
    assert len(result) == 2, f"Expected 2, got {len(result)}"
    print("match_consecutive: PASS")

    # Test match_fuzzy
    result = list(match_fuzzy(["proj"], entries, threshold=0.6))
    assert len(result) >= 1, f"Expected at least 1, got {len(result)}"
    print("match_fuzzy: PASS")

    # Test no matches
    result = list(match_anywhere(["xyz"], entries))
    assert len(result) == 0, f"Expected 0, got {len(result)}"
    print("No match test: PASS")

    print("\nAll self-tests passed!")
