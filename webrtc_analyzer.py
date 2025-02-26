#!/usr/bin/env python3
import os
import json
import sys
from datetime import datetime
#
# We import your existing analysis functions from a separate module,
# or you can just paste them directly into this script.
#
# from analyze_webrtc_dump import analyze_webrtc_dump
# or just copy-paste all your functions from your code block above
#

########################
# PASTE YOUR ANALYZER HERE
########################

def read_tampermonkey_logs(log_path):
    """
    Reads the Tampermonkey 'universal-webrtc-stats-logger' logs,
    which is typically a JSON array of objects, each with fields like:
      [
        {
          "type": "stats",
          "pcId": "pc_abc123",
          "timestamp": "...",
          "rawStats": { ... },
          ...
        },
        {
          "type": "state_change",
          "pcId": "pc_abc123",
          ...
        }
        ...
      ]
    """
    with open(log_path, 'r') as f:
        data = json.load(f)
    # data is presumably a list of log entries
    if not isinstance(data, list):
        raise ValueError("Expected a list of log entries. Got something else.")
    return data

def convert_tampermonkey_to_webrtc_internals_format(logs):
    """
    Converts the array of Tampermonkey log entries into
    a dictionary shaped like Chrome's webrtc_internals dump:
    
    {
      "PeerConnections": {
        "pc_abc123": {
          "stats": {
             "randomId_1": {... rawStats from first stats entry ...},
             "randomId_2": {... rawStats from second stats entry ...},
             ...
          }
        },
        "pc_xyz999": {
          "stats": {...}
        }
      }
    }
    
    We'll just generate a unique ID each time we see a type='stats' object,
    and store its rawStats directly.
    """
    pc_map = {}
    
    for entry in logs:
        if entry.get('type') == 'stats' and 'rawStats' in entry:
            pc_id = entry.get('pcId', 'unknownPc')
            
            if pc_id not in pc_map:
                pc_map[pc_id] = {
                    "stats": {}
                }
            
            raw_stats_dict = entry['rawStats']  # This is the big dictionary of stats objects
            # We just need to merge them into pc_map[pc_id]["stats"] in a stable way.
            # Because each posted "stats" can contain multiple RTCStats items.
            # We'll create a unique key for each "stats" snapshot. 
            # For example, you might do:
            
            # a simple approach: use the log's timestamp as the key
            # or generate an incremental ID
            stamp_str = entry.get('timestamp', '')  # or you can do a random token
            if not stamp_str:
                stamp_str = datetime.now().isoformat()
                
            # But we need a dictionary of stats objects, e.g. {
            #   "IT01V3066186979": {...}, "T01": {...}...
            # }
            # The Tampermonkey rawStats is ALREADY a dict of { statId: { ... } }
            # So we can do:
            pc_map[pc_id]['stats'][stamp_str] = raw_stats_dict
            
    # Build the final top-level structure
    final_dump = {
        "PeerConnections": pc_map
    }
    return final_dump

def transform_and_analyze(log_path, specific_log=None, log_folder='rts_log'):
    # 1) Read the logs from Tampermonkey
    logs = read_tampermonkey_logs(log_path)
    
    # 2) Convert to webrtc_internals style
    transformed = convert_tampermonkey_to_webrtc_internals_format(logs)
    
    # 3) Pass into your existing in-memory analyzer
    #    but your analyze_webrtc_dump expects a file, so let's do it in-memory:
    
    # We'll replicate analyze_webrtc_dump's logic for reading data from memory:
    data = transformed  # This is the final structure
    if not data:
        print("No data after transformation.")
        return
    
    if specific_log is None:
        specific_log = get_start_time_from_stats(data)  # or a fallback
    
    results = {}

    # This next part is basically the same code from your analyze_webrtc_dump:
    for peer_id, peer_data in data.get('PeerConnections', {}).items():
        stats = peer_data.get('stats', {})
        
        # Analyze metrics
        video_stats = analyze_video_stats(stats)
        network_stats = analyze_network_stats(stats)
        
        # Save results to CSV
        save_stats_to_csv(video_stats, network_stats, log_folder, specific_log, peer_id)
        
        # Build a structured dict to return
        peer_result = {
            "video_stats": {},
            "network_stats": {}
        }
        
        # Format video stats
        for metric, metric_data in video_stats.items():
            if metric_data['stats']:
                peer_result["video_stats"][metric] = {
                    'mean': format_float(metric_data['stats']['mean']),
                    'std': format_float(metric_data['stats']['std']),
                    'p50': format_float(metric_data['stats']['p50']),
                    'p75': format_float(metric_data['stats']['p75']),
                    'p99': format_float(metric_data['stats']['p99']),
                    'p99_9': format_float(metric_data['stats']['p99_9']),
                    'length': metric_data['stats']['len']
                }
        
        # Format network stats
        for metric, metric_data in network_stats.items():
            if metric_data['stats']:
                peer_result["network_stats"][metric] = {
                    'mean': format_float(metric_data['stats']['mean']),
                    'std': format_float(metric_data['stats']['std']),
                    'p50': format_float(metric_data['stats']['p50']),
                    'p75': format_float(metric_data['stats']['p75']),
                    'p99': format_float(metric_data['stats']['p99']),
                    'p99_9': format_float(metric_data['stats']['p99_9']),
                    'length': metric_data['stats']['len']
                }
        
        results[peer_id] = peer_result

    return results

def main():
    if len(sys.argv) < 2:
        print("Usage: python transform_and_analyze.py <tampermonkey_log.json> [specific_log_name]")
        sys.exit(1)
    log_path = sys.argv[1]
    specific_log = None
    if len(sys.argv) > 2:
        specific_log = sys.argv[2]
    
    # Perform transform & analyze
    final_results = transform_and_analyze(log_path, specific_log)
    print("==== Final Summaries ====")
    print(json.dumps(final_results, indent=2))

if __name__ == '__main__':
    main()
