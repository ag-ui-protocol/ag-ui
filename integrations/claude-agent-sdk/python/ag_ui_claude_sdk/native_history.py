"""Version-gated local native history recovery. Requires exclusive session ownership."""
import copy
import json
import os
import re
from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone


def blocks(row):
    if row.get('type') not in ('assistant', 'user'):
        return []
    content = row.get('message', {}).get('content', [])
    return content if isinstance(content, list) else []


def interrupted(block):
    return (block.get('type') == 'tool_result' and block.get('is_error') is True
            and isinstance(block.get('content'), str)
            and block['content'].startswith('[Tool call interrupted:'))


def calls(rows):
    result = []
    for row in rows:
        if row.get('type') != 'assistant':
            continue
        for block in blocks(row):
            if block.get('type') != 'tool_use':
                continue
            if not isinstance(block.get('id'), str) or not isinstance(block.get('name'), str) or not isinstance(block.get('input'), dict):
                raise ValueError('Invalid native tool call')
            result.append({key: block[key] for key in ('id', 'name', 'input')})
    return result


def pending(rows):
    done = {b.get('tool_use_id') for r in rows if r.get('type') == 'user' for b in blocks(r)
            if b.get('type') == 'tool_result' and not interrupted(b)}
    done.update(superseded_recovery_bridges(rows))
    return [call for call in calls(rows) if call['id'] not in done]


def superseded_recovery_bridges(rows):
    """Keep unknown bridge results intact; a later recorded delivery supersedes the retry control."""
    message = 'Continue the original task using the recorded tool results. Do not repeat completed tools.'
    bridges = []
    prompt = None
    for row in rows:
        if row.get('type') == 'user':
            prompt = row.get('message', {}).get('content')
        if row.get('type') != 'assistant' or row.get('agentId'):
            continue
        for call in blocks(row):
            args = call.get('input', {})
            if call.get('name') == 'SendMessage' and args.get('message') == message and prompt == f"Resume child {args.get('to')} with SendMessage, message exactly: {message}":
                results = [b for r in rows if r.get('type') == 'user' for b in blocks(r) if b.get('type') == 'tool_result' and b.get('tool_use_id') == call.get('id')]
                if len(results) != 1:
                    continue
                result = results[0]
                delivered = False
                if not result.get('is_error'):
                    try:
                        receipt = json.loads(result['content']) if isinstance(result.get('content'), str) else result.get('content')
                        delivered = isinstance(receipt, dict) and receipt.get('success') is True and receipt.get('resumedAgentId') == args.get('to')
                    except (ValueError, TypeError):
                        pass
                bridges.append((call['id'], args.get('to'), interrupted(result), delivered))
    return {key for index, (key, target, unknown, _) in enumerate(bridges) if unknown and any(other == target and delivered for _, other, _, delivered in bridges[index + 1:])}


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

    def root(self):
        matches = list(self.directory.glob('*/' + self.session_id + '.jsonl'))
        if len(matches) != 1:
            raise ValueError('Expected one original native session')
        path = matches[0]
        rows = read(path)
        unresolved = [c for c in pending(rows) if c['name'] not in ('Agent', 'SendMessage')]
        if any(c['name'] not in self.tools for c in unresolved):
            raise ValueError('Unanswered root tool has no configured recovery executor')
        return dict(parentPath=path, childPath=path, childId='', parent=dict(id='', name='', input={}), calls=calls(rows), pending=unresolved, final=None)

    def assert_root_ready(self):
        if pending(read(self.root()['childPath'])):
            raise ValueError('Unresolved native root tool results; refusing model continuation')

    def result(self, checkpoint, key):
        results = [b for r in read(checkpoint['childPath']) if r['type'] == 'user' for b in blocks(r) if b.get('type') == 'tool_result' and b.get('tool_use_id') == key and not interrupted(b)]
        if len(results) > 1:
            raise ValueError('Ambiguous canonical tool results')
        if not results:
            return None
        result = results[0]
        content = result.get('content')
        return dict(content=content if isinstance(content, str) else json.dumps(content), is_error=bool(result.get('is_error')), rawContent=content)

    def inspect(self):
        return next(iter(self.children()), None)

    def children(self, include_completed=False):
        root = self.root()
        folder = root['childPath'].parent / self.session_id / 'subagents'
        files = list(folder.glob('agent-*.jsonl'))
        records = [dict(path=root['childPath'], id='', rows=read(root['childPath']))] + [dict(path=p, id=p.stem.removeprefix('agent-'), rows=read(p)) for p in files]
        checkpoints = []
        for child in records[1:]:
            if not re.fullmatch(r'[a-zA-Z0-9_-]+', child['id']) or any(r.get('agentId') and r['agentId'] != child['id'] for r in child['rows']):
                raise ValueError('Native child identity mismatch')
            meta_path = child['path'].with_suffix('.meta.json')
            if meta_path.is_symlink():
                raise ValueError('Native child metadata must not be a symlink')
            meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
            tool_id = meta.get('toolUseId')
            parents = [(owner, call) for owner in records for call in calls(owner['rows']) if call['name'] == 'Agent' and (call['id'] == tool_id if tool_id else owner['id'] == '')]
            if len(parents) != 1 or (not tool_id and len(files) != 1):
                raise ValueError('Expected one child parent identity in native metadata')
            owner, call = parents[0]
            if owner['id'] == child['id']:
                raise ValueError('Cyclic child identity')
            if meta.get('parentAgentId') and meta['parentAgentId'] != owner['id']:
                raise ValueError('Native child parent identity mismatch')
            unfinished = pending(child['rows'])
            unanswered = [c for c in unfinished if c['name'] != 'Agent']
            if any(c['name'] not in self.tools for c in unanswered):
                raise ValueError('Unanswered child tool has no configured recovery executor')
            messages = [r for r in child['rows'] if r['type'] in ('assistant', 'user')]
            last = messages[-1] if messages else {}
            final = '\n'.join(b.get('text', '') for b in blocks(last) if b['type'] == 'text') if not unfinished and last.get('type') == 'assistant' and last.get('message', {}).get('stop_reason') == 'end_turn' else None
            parent_resolved = not any(c['id'] == call['id'] for c in pending(owner['rows']))
            recorded = any(r.get('agUiRecoveredChildId') == child['id'] for r in owner['rows'])
            if not include_completed and parent_resolved and final is not None and (call['input'].get('run_in_background') is not True or recorded):
                continue
            checkpoints.append(dict(rootPath=root['childPath'], parentPath=owner['path'], ownerAgentId=owner['id'] or None, childPath=child['path'], childId=child['id'], parent=call, parentResolved=parent_resolved, pending=unanswered, calls=calls(child['rows']), final=final, dependencies=[c['id'] for c in unfinished if c['name'] == 'Agent']))
        for record in records:
            for call in pending(record['rows']):
                if call['name'] == 'Agent' and not any(c['parent']['id'] == call['id'] for c in checkpoints):
                    raise ValueError('Pending Agent has no recoverable native child identity')
        return checkpoints

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
        # A resolved SDK defer is no longer an executable pending attachment.
        # Retain its provenance on the real result and reconnect native ancestry.
        deferred = [r for r in rows if r.get('type') == 'attachment' and r.get('attachment', {}).get('type') == 'hook_deferred_tool' and r['attachment'].get('toolUseID') in results]
        for marker in deferred:
            target = next(r for r in rows if r.get('type') == 'user' and any(b.get('tool_use_id') == marker['attachment']['toolUseID'] for b in blocks(r)))
            target.setdefault('agUiResolvedDeferrals', []).append(copy.deepcopy(marker))
            for record in rows:
                if record.get('parentUuid') == marker['uuid']:
                    record['parentUuid'] = marker.get('parentUuid')
                if record.get('leafUuid') == marker['uuid']:
                    record['leafUuid'] = marker.get('parentUuid')
            rows.remove(marker)
        replace(path, before, rows)

    def settle_bridge(self, checkpoint, results):
        bridge_path = checkpoint.get('rootPath', checkpoint['parentPath'])
        unanswered = {c['id'] for c in pending(read(bridge_path))}
        missing = {key: value for key, value in results.items() if key in unanswered}
        if missing:
            self.answer({**checkpoint, 'childPath': bridge_path}, missing)

    def completed(self, checkpoint):
        rows = read(checkpoint['childPath'])
        messages = [r for r in rows if r['type'] in ('assistant', 'user')]
        last = messages[-1] if messages else {}
        return not pending(rows) and last.get('type') == 'assistant' and last.get('message', {}).get('stop_reason') == 'end_turn' and not any(b.get('type') == 'tool_use' for b in blocks(last))

    def repair(self, checkpoint):
        fresh = next((c for c in self.children() if c['childId'] == checkpoint['childId']), None)
        if not fresh or fresh['final'] is None or fresh['pending'] or fresh['childId'] != checkpoint['childId']:
            raise ValueError('Child has not completed recovery')
        if fresh.get('rootPath') and any(c['name'] == 'SendMessage' for c in pending(read(fresh['rootPath']))):
            raise ValueError('Unresolved recovery tool result; parent remains unresolved')
        before = read(fresh['parentPath'])
        rows = copy.deepcopy(before)
        # Child completion does not prove an interrupted bridge call's outcome.
        if any(call['id'] != fresh['parent']['id'] and call['name'] != 'Agent' for call in pending(before)):
            raise ValueError('Unresolved recovery tool result; parent remains unresolved')
        if fresh.get('parentResolved'):
            last = [r for r in rows if r.get('uuid')][-1]
            rows.append(dict(type='user', uuid=str(uuid4()), parentUuid=last['uuid'], sessionId=self.session_id, version='2.1.306', agentId=fresh.get('ownerAgentId'), isSidechain=bool(fresh.get('ownerAgentId')), timestamp=datetime.now(timezone.utc).isoformat(), cwd=last.get('cwd'), userType=last.get('userType'), agUiRecoveredChildId=fresh['childId'], message=dict(role='user', content=f"Recovered child {fresh['childId']} completed: {fresh['final']}")))
            replace(fresh['parentPath'], before, rows)
            return
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
            rows.append(dict(**{k:source[k] for k in ('agentId','isSidechain','cwd','userType','entrypoint') if k in source}, type='user', uuid=str(uuid4()), parentUuid=last['uuid'], sourceToolAssistantUUID=source['uuid'], sessionId=self.session_id,
                             version=source.get('version'), timestamp=datetime.now(timezone.utc).isoformat(),
                             message={'role':'user','content':[dict(type='tool_result',tool_use_id=fresh['parent']['id'],content=fresh['final'],is_error=False)]},toolUseResult=fresh['final']))
        replace(fresh['parentPath'], before, rows)
