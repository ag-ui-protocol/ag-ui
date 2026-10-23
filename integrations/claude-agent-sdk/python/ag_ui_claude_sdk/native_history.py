"""Version-gated local native history recovery. Requires exclusive session ownership."""
import copy
import json
import os
import re
from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone


def blocks(row):
    content = row.get('message', {}).get('content', [])
    return content if isinstance(content, list) else []


def interrupted(block):
    return (block.get('type') == 'tool_result' and block.get('is_error') is True
            and isinstance(block.get('content'), str)
            and block['content'].startswith('[Tool call interrupted:'))


def calls(rows):
    result = []
    for row in rows:
        for block in blocks(row):
            if block.get('type') != 'tool_use':
                continue
            if not isinstance(block.get('id'), str) or not isinstance(block.get('name'), str) or not isinstance(block.get('input'), dict):
                raise ValueError('Invalid native tool call')
            result.append({key: block[key] for key in ('id', 'name', 'input')})
    return result


def pending(rows):
    done = {b.get('tool_use_id') for r in rows for b in blocks(r)
            if b.get('type') == 'tool_result' and not interrupted(b)}
    return [call for call in calls(rows) if call['id'] not in done]


def read(path):
    if path.is_symlink():
        raise ValueError('Native transcripts must not be symlinks')
    rows = [json.loads(line) for line in path.read_text().splitlines() if line]
    if any(row.get('version') and row['version'] != '2.1.306' for row in rows):
        raise ValueError('Native child recovery requires verified CLI history version 2.1.306')
    return rows


def replace(path, before, after):
    if read(path) != before:
        raise ValueError('Native history changed during recovery')
    temp = path.with_name(path.name + '.' + str(uuid4()) + '.tmp')
    with temp.open('x') as stream:
        os.chmod(temp, 0o600)
        stream.write(''.join(json.dumps(row) + '\n' for row in after))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


class NativeHistory:
    def __init__(self, directory, session_id, tools):
        if not isinstance(session_id, str) or not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', session_id):
            raise ValueError('Invalid native session UUID')
        self.directory, self.session_id, self.tools = Path(directory), session_id, tools

    def inspect(self):
        matches = list(self.directory.glob('*/' + self.session_id + '.jsonl'))
        if len(matches) != 1:
            raise ValueError('Expected one original native session')
        parent_path = matches[0]
        unfinished = pending(read(parent_path))
        parents = [call for call in unfinished if call['name'] == 'Agent']
        if not parents:
            return None
        if len(parents) != 1:
            raise ValueError('Native recovery currently requires one unresolved parent Agent call')
        children = list((parent_path.parent / self.session_id / 'subagents').glob('agent-*.jsonl'))
        if len(children) != 1:
            raise ValueError('Native recovery requires exactly one child; ambiguous or nested recovery is unsupported')
        child_path = children[0]
        child_id = child_path.stem.removeprefix('agent-')
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', child_id):
            raise ValueError('Invalid native child ID')
        if any(c['id'] != parents[0]['id'] and not (c['name'] == 'SendMessage' and c['input'].get('to') == child_id and c['input'].get('message') == 'Continue the original task using the recorded tool results. Do not repeat completed tools.') for c in unfinished):
            raise ValueError('Unresolved parent tools outside child recovery')
        rows = read(child_path)
        if any(r.get('agentId') and r['agentId'] != child_id for r in rows):
            raise ValueError('Native child identity mismatch')
        unanswered = pending(rows)
        if any(c['name'] not in self.tools for c in unanswered):
            raise ValueError('Unanswered child tool has no configured recovery executor')
        messages = [r for r in rows if r['type'] in ('assistant', 'user')]
        last = messages[-1] if messages else {}
        final = None
        if last.get('type') == 'assistant' and last.get('message', {}).get('stop_reason') == 'end_turn':
            final = '\n'.join(b.get('text', '') for b in blocks(last) if b['type'] == 'text')
        return dict(parentPath=parent_path, childPath=child_path, childId=child_id,
                    parent=parents[0], pending=unanswered, calls=calls(rows), final=final)

    def answer(self, checkpoint, results):
        path = checkpoint['childPath']
        before = read(path)
        rows = copy.deepcopy(before)
        unanswered = {c['id'] for c in pending(rows)}
        if any(key not in unanswered for key in results):
            raise ValueError('Answer does not match an unanswered native call')
        ancestors = [r for r in rows if r.get('uuid')]
        sources = [r for r in rows if r['type'] == 'assistant' and any(b.get('id') in results for b in blocks(r))]
        if not ancestors or not sources:
            raise ValueError('Missing native call ancestry')
        remaining = dict(results)
        for row in rows:
            for block in blocks(row):
                key = block.get('tool_use_id')
                if key in remaining and interrupted(block):
                    result = remaining.pop(key)
                    block.update(content=result['content'], is_error=bool(result.get('is_error')))
                    row['toolUseResult'] = result['content']
                    row.pop('toolDenialKind', None)
        if remaining:
            source = sources[0]
            row = {k: source[k] for k in ('sessionId', 'agentId', 'isSidechain', 'cwd', 'version', 'userType', 'entrypoint') if k in source}
            row.update(type='user', uuid=str(uuid4()), parentUuid=ancestors[-1]['uuid'],
                       sourceToolAssistantUUID=source['uuid'], timestamp=datetime.now(timezone.utc).isoformat(),
                       message={'role': 'user', 'content': [dict(type='tool_result', tool_use_id=key, content=r['content'], is_error=bool(r.get('is_error'))) for key, r in remaining.items()]})
            rows.append(row)
        replace(path, before, rows)

    def settle_bridge(self, checkpoint, results):
        unanswered = {c['id'] for c in pending(read(checkpoint['parentPath']))}
        missing = {key: value for key, value in results.items() if key in unanswered}
        if missing:
            self.answer({**checkpoint, 'childPath': checkpoint['parentPath']}, missing)

    def completed(self, checkpoint):
        rows = read(checkpoint['childPath'])
        messages = [r for r in rows if r['type'] in ('assistant', 'user')]
        last = messages[-1] if messages else {}
        return not pending(rows) and last.get('type') == 'assistant' and last.get('message', {}).get('stop_reason') == 'end_turn' and not any(b.get('type') == 'tool_use' for b in blocks(last))

    def repair(self, checkpoint):
        fresh = self.inspect()
        if not fresh or fresh['final'] is None or fresh['pending'] or fresh['childId'] != checkpoint['childId']:
            raise ValueError('Child has not completed recovery')
        before = read(fresh['parentPath'])
        rows = copy.deepcopy(before)
        # Child completion does not prove an interrupted bridge call's outcome.
        if any(call['id'] != fresh['parent']['id'] for call in pending(before)):
            raise ValueError('Unresolved recovery tool result; parent remains unresolved')
        changed = False
        for row in rows:
            for block in blocks(row):
                if block.get('tool_use_id') == fresh['parent']['id']:
                    if not interrupted(block):
                        raise ValueError('Parent result was already resolved')
                    block.update(content=fresh['final'], is_error=False)
                    row['toolUseResult'] = fresh['final']
                    row.pop('toolDenialKind', None)
                    changed = True
        if not changed:
            source = next(r for r in rows if any(b.get('id') == fresh['parent']['id'] for b in blocks(r)))
            last = [r for r in rows if r.get('uuid')][-1]
            rows.append(dict(type='user', uuid=str(uuid4()), parentUuid=last['uuid'], sessionId=self.session_id,
                             version=source.get('version'), timestamp=datetime.now(timezone.utc).isoformat(),
                             message={'role':'user','content':[dict(type='tool_result',tool_use_id=fresh['parent']['id'],content=fresh['final'],is_error=False)]},toolUseResult=fresh['final']))
        replace(fresh['parentPath'], before, rows)
